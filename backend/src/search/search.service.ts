import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Market } from '../markets/entities/market.entity';
import { User } from '../users/entities/user.entity';
import {
  Competition,
  CompetitionVisibility,
} from '../competitions/entities/competition.entity';
import {
  GlobalSearchDto,
  GlobalSearchResponseDto,
  MarketSearchResult,
  UserSearchResult,
  CompetitionSearchResult,
  SearchType,
  SuggestionsResponseDto,
} from './dto/global-search.dto';
import { escapeLikeWildcards } from './dto/search-query.dto';

/**
 * Minimum number of FTS hits required before we skip the trigram fallback.
 * If FTS returns fewer results than this threshold, we merge in trigram
 * similarity results so single-typo queries still surface relevant hits.
 */
const FTS_FALLBACK_THRESHOLD = 3;

/**
 * Minimum trigram similarity score a row must have to be included in the
 * fallback result set (0–1, where 1 = identical strings).
 */
const TRGM_SIMILARITY_THRESHOLD = 0.1;

@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(Market)
    private readonly marketsRepository: Repository<Market>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Competition)
    private readonly competitionsRepository: Repository<Competition>,
  ) {}

  async search(dto: GlobalSearchDto): Promise<GlobalSearchResponseDto> {
    const page = dto.page ?? 1;
    const limit = Math.min(dto.limit ?? 20, 50);
    const skip = (page - 1) * limit;
    const searchType = dto.type ?? SearchType.All;
    const query = dto.query;

    const [
      [markets, total_markets],
      [users, total_users],
      [competitions, total_competitions],
    ] = await Promise.all([
      searchType === SearchType.All || searchType === SearchType.Markets
        ? this.searchMarkets(query, skip, limit)
        : Promise.resolve([[], 0] as [MarketSearchResult[], number]),
      searchType === SearchType.All || searchType === SearchType.Users
        ? this.searchUsers(query, skip, limit)
        : Promise.resolve([[], 0] as [UserSearchResult[], number]),
      searchType === SearchType.All || searchType === SearchType.Competitions
        ? this.searchCompetitions(query, skip, limit)
        : Promise.resolve([[], 0] as [CompetitionSearchResult[], number]),
    ]);

    const total = total_markets + total_users + total_competitions;

    return {
      markets,
      users,
      competitions,
      total,
      total_markets,
      total_users,
      total_competitions,
      page,
      limit,
    };
  }

  async getSuggestions(q: string): Promise<SuggestionsResponseDto> {
    const term = q?.trim() ?? '';
    if (term.length < 1) {
      return { markets: [], users: [] };
    }

    // Escape SQL LIKE wildcards to match them literally
    const escapedTerm = escapeLikeWildcards(term);

    const [markets, users] = await Promise.all([
      this.marketsRepository
        .createQueryBuilder('market')
        .select('market.title')
        .where('market.is_public = :isPublic', { isPublic: true })
        .andWhere('market.title ILIKE :term', { term: `${escapedTerm}%` })
        .orderBy('market.title', 'ASC')
        .limit(5)
        .getMany(),
      this.usersRepository
        .createQueryBuilder('user')
        .select('user.username')
        .where('user.is_banned = :banned', { banned: false })
        .andWhere('user.username IS NOT NULL')
        .andWhere('user.username ILIKE :term', { term: `${escapedTerm}%` })
        .orderBy('user.username', 'ASC')
        .limit(5)
        .getMany(),
    ]);

    return {
      markets: markets.map((m) => m.title),
      users: users.map((u) => u.username).filter(Boolean) as string[],
    };
  }

  // ---------------------------------------------------------------------------
  // Markets
  // ---------------------------------------------------------------------------

  private async searchMarkets(
    query: string,
    skip: number,
    limit: number,
  ): Promise<[MarketSearchResult[], number]> {
    // Phase 1: full-text search with ranking + headline
    const ftsQb = this.marketsRepository
      .createQueryBuilder('market')
      .select([
        'market.id',
        'market.title',
        'market.description',
        'market.category',
        'market.is_resolved',
        'market.is_public',
        'market.participant_count',
        'market.created_at',
      ])
      .addSelect(
        `ts_rank(market.search_vector, plainto_tsquery('english', :query))`,
        'fts_rank',
      )
      .addSelect(
        `greatest(
          similarity(market.title, :query),
          similarity(coalesce(market.description, ''), :query)
        )`,
        'trgm_score',
      )
      .addSelect(
        `ts_headline(
          'english',
          coalesce(market.title, '') || ' ' || coalesce(market.description, ''),
          plainto_tsquery('english', :query),
          'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15, ShortWord=3'
        )`,
        'headline',
      )
      .where('market.is_public = :isPublic', { isPublic: true })
      .andWhere(`market.search_vector @@ plainto_tsquery('english', :query)`, {
        query,
      })
      .setParameter('query', query)
      .orderBy(
        `ts_rank(market.search_vector, plainto_tsquery('english', :query))`,
        'DESC',
      )
      .addOrderBy('market.id', 'ASC');

    const [ftsRaw, ftsCount] = await ftsQb.getManyAndCount();

    if (ftsCount >= FTS_FALLBACK_THRESHOLD) {
      return [
        this.mapMarketsWithScore(ftsRaw, skip, limit),
        ftsCount,
      ];
    }

    // Phase 2: trigram fallback — merge FTS hits with similarity hits
    const trgmQb = this.marketsRepository
      .createQueryBuilder('market')
      .select([
        'market.id',
        'market.title',
        'market.description',
        'market.category',
        'market.is_resolved',
        'market.is_public',
        'market.participant_count',
        'market.created_at',
      ])
      .addSelect(
        `ts_rank(market.search_vector, plainto_tsquery('english', :query))`,
        'fts_rank',
      )
      .addSelect(
        `greatest(
          similarity(market.title, :query),
          similarity(coalesce(market.description, ''), :query)
        )`,
        'trgm_score',
      )
      .addSelect(
        `ts_headline(
          'english',
          coalesce(market.title, '') || ' ' || coalesce(market.description, ''),
          plainto_tsquery('english', :query),
          'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15, ShortWord=3'
        )`,
        'headline',
      )
      .where('market.is_public = :isPublic', { isPublic: true })
      .andWhere(
        `(
          market.search_vector @@ plainto_tsquery('english', :query)
          OR greatest(
            similarity(market.title, :query),
            similarity(coalesce(market.description, ''), :query)
          ) >= :trgmThreshold
        )`,
        { query, trgmThreshold: TRGM_SIMILARITY_THRESHOLD },
      )
      .setParameter('query', query)
      .orderBy(
        `(
          ts_rank(market.search_vector, plainto_tsquery('english', :query)) +
          greatest(
            similarity(market.title, :query),
            similarity(coalesce(market.description, ''), :query)
          )
        )`,
        'DESC',
      )
      .addOrderBy('market.id', 'ASC');

    const [trgmRaw, trgmCount] = await trgmQb.getManyAndCount();

    return [
      this.mapMarketsWithScore(trgmRaw, skip, limit),
      trgmCount,
    ];
  }

  private mapMarketsWithScore(
    raw: (Market & { fts_rank?: string; trgm_score?: string; headline?: string })[],
    skip: number,
    limit: number,
  ): MarketSearchResult[] {
    return raw.slice(skip, skip + limit).map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      category: m.category,
      is_resolved: m.is_resolved,
      is_public: m.is_public,
      participant_count: m.participant_count,
      created_at: m.created_at,
      relevance_score:
        parseFloat(m.fts_rank ?? '0') + parseFloat(m.trgm_score ?? '0'),
      highlight: m.headline ?? m.title,
    }));
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  private async searchUsers(
    query: string,
    skip: number,
    limit: number,
  ): Promise<[UserSearchResult[], number]> {
    const ftsQb = this.usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.username',
        'user.stellar_address',
        'user.avatar_url',
        'user.reputation_score',
        'user.total_predictions',
      ])
      .addSelect(
        `ts_rank(user.search_vector, plainto_tsquery('simple', :query))`,
        'fts_rank',
      )
      .addSelect(
        `similarity(coalesce(user.username, ''), :query)`,
        'trgm_score',
      )
      .addSelect(
        `ts_headline(
          'simple',
          coalesce(user.username, '') || ' ' || coalesce(user.stellar_address, ''),
          plainto_tsquery('simple', :query),
          'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15, ShortWord=1'
        )`,
        'headline',
      )
      .where('user.is_banned = :banned', { banned: false })
      .andWhere(`user.search_vector @@ plainto_tsquery('simple', :query)`, {
        query,
      })
      .setParameter('query', query)
      .orderBy(
        `ts_rank(user.search_vector, plainto_tsquery('simple', :query))`,
        'DESC',
      )
      .addOrderBy('user.id', 'ASC');

    const [ftsRaw, ftsCount] = await ftsQb.getManyAndCount();

    if (ftsCount >= FTS_FALLBACK_THRESHOLD) {
      return [this.mapUsersWithScore(ftsRaw, skip, limit), ftsCount];
    }

    // Trigram fallback
    const trgmQb = this.usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.username',
        'user.stellar_address',
        'user.avatar_url',
        'user.reputation_score',
        'user.total_predictions',
      ])
      .addSelect(
        `ts_rank(user.search_vector, plainto_tsquery('simple', :query))`,
        'fts_rank',
      )
      .addSelect(
        `similarity(coalesce(user.username, ''), :query)`,
        'trgm_score',
      )
      .addSelect(
        `ts_headline(
          'simple',
          coalesce(user.username, '') || ' ' || coalesce(user.stellar_address, ''),
          plainto_tsquery('simple', :query),
          'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15, ShortWord=1'
        )`,
        'headline',
      )
      .where('user.is_banned = :banned', { banned: false })
      .andWhere(
        `(
          user.search_vector @@ plainto_tsquery('simple', :query)
          OR similarity(coalesce(user.username, ''), :query) >= :trgmThreshold
        )`,
        { query, trgmThreshold: TRGM_SIMILARITY_THRESHOLD },
      )
      .setParameter('query', query)
      .orderBy(
        `(
          ts_rank(user.search_vector, plainto_tsquery('simple', :query)) +
          similarity(coalesce(user.username, ''), :query)
        )`,
        'DESC',
      )
      .addOrderBy('user.id', 'ASC');

    const [trgmRaw, trgmCount] = await trgmQb.getManyAndCount();

    return [this.mapUsersWithScore(trgmRaw, skip, limit), trgmCount];
  }

  private mapUsersWithScore(
    raw: (User & { fts_rank?: string; trgm_score?: string; headline?: string })[],
    skip: number,
    limit: number,
  ): UserSearchResult[] {
    return raw.slice(skip, skip + limit).map((u) => ({
      id: u.id,
      username: u.username,
      stellar_address: u.stellar_address,
      avatar_url: u.avatar_url,
      reputation_score: u.reputation_score,
      total_predictions: u.total_predictions,
      relevance_score:
        parseFloat(u.fts_rank ?? '0') + parseFloat(u.trgm_score ?? '0'),
      highlight: u.headline ?? u.username ?? u.stellar_address,
    }));
  }

  // ---------------------------------------------------------------------------
  // Competitions
  // ---------------------------------------------------------------------------

  private async searchCompetitions(
    query: string,
    skip: number,
    limit: number,
  ): Promise<[CompetitionSearchResult[], number]> {
    const ftsQb = this.competitionsRepository
      .createQueryBuilder('competition')
      .select([
        'competition.id',
        'competition.title',
        'competition.description',
        'competition.start_time',
        'competition.end_time',
        'competition.participant_count',
        'competition.visibility',
      ])
      .addSelect(
        `ts_rank(competition.search_vector, plainto_tsquery('english', :query))`,
        'fts_rank',
      )
      .addSelect(
        `greatest(
          similarity(competition.title, :query),
          similarity(coalesce(competition.description, ''), :query)
        )`,
        'trgm_score',
      )
      .addSelect(
        `ts_headline(
          'english',
          coalesce(competition.title, '') || ' ' || coalesce(competition.description, ''),
          plainto_tsquery('english', :query),
          'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15, ShortWord=3'
        )`,
        'headline',
      )
      .where('competition.visibility = :visibility', {
        visibility: CompetitionVisibility.Public,
      })
      .andWhere(
        `competition.search_vector @@ plainto_tsquery('english', :query)`,
        { query },
      )
      .setParameter('query', query)
      .orderBy(
        `ts_rank(competition.search_vector, plainto_tsquery('english', :query))`,
        'DESC',
      )
      .addOrderBy('competition.id', 'ASC');

    const [ftsRaw, ftsCount] = await ftsQb.getManyAndCount();

    if (ftsCount >= FTS_FALLBACK_THRESHOLD) {
      return [
        this.mapCompetitionsWithScore(ftsRaw, skip, limit),
        ftsCount,
      ];
    }

    // Trigram fallback
    const trgmQb = this.competitionsRepository
      .createQueryBuilder('competition')
      .select([
        'competition.id',
        'competition.title',
        'competition.description',
        'competition.start_time',
        'competition.end_time',
        'competition.participant_count',
        'competition.visibility',
      ])
      .addSelect(
        `ts_rank(competition.search_vector, plainto_tsquery('english', :query))`,
        'fts_rank',
      )
      .addSelect(
        `greatest(
          similarity(competition.title, :query),
          similarity(coalesce(competition.description, ''), :query)
        )`,
        'trgm_score',
      )
      .addSelect(
        `ts_headline(
          'english',
          coalesce(competition.title, '') || ' ' || coalesce(competition.description, ''),
          plainto_tsquery('english', :query),
          'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15, ShortWord=3'
        )`,
        'headline',
      )
      .where('competition.visibility = :visibility', {
        visibility: CompetitionVisibility.Public,
      })
      .andWhere(
        `(
          competition.search_vector @@ plainto_tsquery('english', :query)
          OR greatest(
            similarity(competition.title, :query),
            similarity(coalesce(competition.description, ''), :query)
          ) >= :trgmThreshold
        )`,
        { query, trgmThreshold: TRGM_SIMILARITY_THRESHOLD },
      )
      .setParameter('query', query)
      .orderBy(
        `(
          ts_rank(competition.search_vector, plainto_tsquery('english', :query)) +
          greatest(
            similarity(competition.title, :query),
            similarity(coalesce(competition.description, ''), :query)
          )
        )`,
        'DESC',
      )
      .addOrderBy('competition.id', 'ASC');

    const [trgmRaw, trgmCount] = await trgmQb.getManyAndCount();

    return [
      this.mapCompetitionsWithScore(trgmRaw, skip, limit),
      trgmCount,
    ];
  }

  private mapCompetitionsWithScore(
    raw: (Competition & {
      fts_rank?: string;
      trgm_score?: string;
      headline?: string;
    })[],
    skip: number,
    limit: number,
  ): CompetitionSearchResult[] {
    return raw.slice(skip, skip + limit).map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      start_time: c.start_time,
      end_time: c.end_time,
      participant_count: c.participant_count,
      visibility: c.visibility,
      relevance_score:
        parseFloat(c.fts_rank ?? '0') + parseFloat(c.trgm_score ?? '0'),
      highlight: c.headline ?? c.title,
    }));
  }
}
