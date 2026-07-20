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
  SearchType,
  SuggestionsResponseDto,
} from './dto/global-search.dto';
import { escapeLikeWildcards } from './dto/search-query.dto';

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

    // Query is already validated by DTO (2-100 chars, trimmed, whitespace normalized)
    // Note: Full-text search with plainto_tsquery doesn't need LIKE wildcard escaping
    // because it uses lexeme matching, not pattern matching

    const [
      [markets, total_markets],
      [users, total_users],
      [competitions, total_competitions],
    ] = await Promise.all([
      searchType === SearchType.All || searchType === SearchType.Markets
        ? this.searchMarkets(query, skip, limit)
        : Promise.resolve([[], 0] as [Market[], number]),
      searchType === SearchType.All || searchType === SearchType.Users
        ? this.searchUsers(query, skip, limit)
        : Promise.resolve([[], 0] as [User[], number]),
      searchType === SearchType.All || searchType === SearchType.Competitions
        ? this.searchCompetitions(query, skip, limit)
        : Promise.resolve([[], 0] as [Competition[], number]),
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

  private async searchMarkets(
    query: string,
    skip: number,
    limit: number,
  ): Promise<[Market[], number]> {
    return this.marketsRepository
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
      .where('market.is_public = :isPublic', { isPublic: true })
      .andWhere(`market.search_vector @@ plainto_tsquery('english', :query)`, {
        query,
      })
      .orderBy(
        `ts_rank(market.search_vector, plainto_tsquery('english', :query))`,
        'DESC',
      )
      .skip(skip)
      .take(limit)
      .getManyAndCount();
  }

  private async searchUsers(
    query: string,
    skip: number,
    limit: number,
  ): Promise<[User[], number]> {
    return this.usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.username',
        'user.stellar_address',
        'user.avatar_url',
        'user.reputation_score',
        'user.total_predictions',
      ])
      .where('user.is_banned = :banned', { banned: false })
      .andWhere(`user.search_vector @@ plainto_tsquery('simple', :query)`, {
        query,
      })
      .orderBy(
        `ts_rank(user.search_vector, plainto_tsquery('simple', :query))`,
        'DESC',
      )
      .skip(skip)
      .take(limit)
      .getManyAndCount();
  }

  private async searchCompetitions(
    query: string,
    skip: number,
    limit: number,
  ): Promise<[Competition[], number]> {
    return this.competitionsRepository
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
      .where('competition.visibility = :visibility', {
        visibility: CompetitionVisibility.Public,
      })
      .andWhere(
        `competition.search_vector @@ plainto_tsquery('english', :query)`,
        { query },
      )
      .orderBy(
        `ts_rank(competition.search_vector, plainto_tsquery('english', :query))`,
        'DESC',
      )
      .skip(skip)
      .take(limit)
      .getManyAndCount();
  }
}
