import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  LessThan,
  IsNull,
  MoreThanOrEqual,
} from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { LeaderboardHistory } from './entities/leaderboard-history.entity';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import {
  LeaderboardQueryDto,
  LeaderboardEntryResponse,
  PaginatedLeaderboardResponse,
} from './dto/leaderboard-query.dto';
import {
  LeaderboardHistoryQueryDto,
  LeaderboardHistoryEntryResponse,
  PaginatedLeaderboardHistoryResponse,
} from './dto/leaderboard-history.dto';
import { UserRankDto } from './dto/user-rank.dto';
import {
  CursorPaginationDto,
  PaginatedCursorResponse,
} from './dto/cursor-pagination.dto';
import { CACHE_WARMING_KEYS } from '../cache/cache-warming.keys';
import { SeasonsService } from '../seasons/seasons.service';

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);
  private readonly CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour

  constructor(
    @InjectRepository(LeaderboardEntry)
    private readonly leaderboardRepository: Repository<LeaderboardEntry>,
    @InjectRepository(LeaderboardHistory)
    private readonly historyRepository: Repository<LeaderboardHistory>,
    private readonly usersService: UsersService,
    private readonly seasonsService: SeasonsService,
    private readonly dataSource: DataSource,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async getLeaderboard(
    query: LeaderboardQueryDto,
  ): Promise<PaginatedLeaderboardResponse> {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const qb = this.leaderboardRepository
      .createQueryBuilder('entry')
      .leftJoinAndSelect('entry.user', 'user');

    if (query.season_id) {
      qb.where('entry.season_id = :season_id', { season_id: query.season_id });
      qb.orderBy('entry.season_points', 'DESC');
    } else {
      qb.where('entry.season_id IS NULL');
      qb.orderBy('entry.reputation_score', 'DESC');
    }

    qb.addOrderBy('entry.rank', 'ASC').skip(skip).take(limit);

    const [entries, total] = await qb.getManyAndCount();

    const data: LeaderboardEntryResponse[] = entries.map((entry) => {
      const accuracyRate =
        entry.total_predictions > 0
          ? (
              (entry.correct_predictions / entry.total_predictions) *
              100
            ).toFixed(1)
          : '0.0';

      return {
        rank: entry.rank,
        user_id: entry.user_id,
        username: entry.user?.username ?? null,
        stellar_address: entry.user?.stellar_address ?? '',
        reputation_score: entry.reputation_score,
        accuracy_rate: accuracyRate,
        total_winnings_stroops: entry.total_winnings_stroops,
        season_points: entry.season_points,
      };
    });

    return { data, total, page, limit };
  }

  async getTopLeaderboard(limit: number): Promise<LeaderboardEntryResponse[]> {
    const season = await this.seasonsService.findActive();
    const cappedLimit = Math.min(limit, 20);

    const [entries] = await this.leaderboardRepository
      .createQueryBuilder('entry')
      .leftJoinAndSelect('entry.user', 'user')
      .where('entry.season_id = :season_id', { season_id: season.id })
      .orderBy('entry.rank', 'ASC')
      .take(cappedLimit)
      .getManyAndCount();

    return entries.map((entry) => ({
      rank: entry.rank,
      user_id: entry.user_id,
      username: entry.user?.username ?? null,
      stellar_address: entry.user?.stellar_address ?? '',
      reputation_score: entry.reputation_score,
      accuracy_rate:
        entry.total_predictions > 0
          ? (
              (entry.correct_predictions / entry.total_predictions) *
              100
            ).toFixed(1)
          : '0.0',
      total_winnings_stroops: entry.total_winnings_stroops,
      season_points: entry.season_points,
    }));
  }

  /**
   * Get leaderboard with cursor-based pagination and caching
   * Cursor is keyed on (rank, user_id) for stable pagination
   */
  async getLeaderboardCursor(
    query: CursorPaginationDto,
  ): Promise<PaginatedCursorResponse> {
    const limit = Math.min(query.limit ?? 20, 100);
    const cacheKey = CACHE_WARMING_KEYS.leaderboardCursor(
      query.season_id ?? null,
      query.cursor ? 1 : 0,
    );

    const cached =
      await this.cacheManager.get<PaginatedCursorResponse>(cacheKey);
    if (cached && !query.cursor) {
      this.logger.debug(`Cache hit for cursor pagination: ${cacheKey}`);
      return cached;
    }

    const qb = this.leaderboardRepository
      .createQueryBuilder('entry')
      .leftJoinAndSelect('entry.user', 'user');

    if (query.season_id) {
      qb.where('entry.season_id = :season_id', { season_id: query.season_id });
      qb.orderBy('entry.season_points', 'DESC');
    } else {
      qb.where('entry.season_id IS NULL');
      qb.orderBy('entry.reputation_score', 'DESC');
    }

    qb.addOrderBy('entry.rank', 'ASC');

    if (query.cursor) {
      const [rankStr, userId] = query.cursor.split(':');
      const rank = parseInt(rankStr, 10);

      const cursorEntry = await this.leaderboardRepository.findOne({
        where: { rank, user_id: userId },
      });

      if (cursorEntry) {
        if (query.season_id) {
          qb.andWhere(
            '(entry.season_points < :season_points OR (entry.season_points = :season_points AND entry.rank > :rank))',
            {
              season_points: cursorEntry.season_points,
              rank: cursorEntry.rank,
            },
          );
        } else {
          qb.andWhere(
            '(entry.reputation_score < :reputation_score OR (entry.reputation_score = :reputation_score AND entry.rank > :rank))',
            {
              reputation_score: cursorEntry.reputation_score,
              rank: cursorEntry.rank,
            },
          );
        }
      }
    }

    const entries = await qb.take(limit + 1).getMany();

    const hasMore = entries.length > limit;
    const data = entries.slice(0, limit).map((entry) => {
      const accuracyRate =
        entry.total_predictions > 0
          ? (
              (entry.correct_predictions / entry.total_predictions) *
              100
            ).toFixed(1)
          : '0.0';

      const cursor = `${entry.rank}:${entry.user_id}`;

      return {
        rank: entry.rank,
        user_id: entry.user_id,
        username: entry.user?.username ?? null,
        stellar_address: entry.user?.stellar_address ?? '',
        reputation_score: entry.reputation_score,
        accuracy_rate: accuracyRate,
        total_winnings_stroops: entry.total_winnings_stroops,
        season_points: entry.season_points,
        cursor,
      };
    });

    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1].cursor : null;
    const result: PaginatedCursorResponse = {
      data,
      next_cursor: nextCursor,
      has_more: hasMore,
      limit,
    };

    if (!query.cursor) {
      await this.cacheManager.set(cacheKey, result, this.CACHE_TTL_MS);
      this.logger.debug(`Cached cursor pagination page: ${cacheKey}`);
    }

    return result;
  }

  /**
   * Get top N entries for current season or all-time, lightweight shortcut
   * Capped at 20, served from cache when available for the first page
   */
  async getTopN(
    n: number,
    seasonId?: string,
  ): Promise<LeaderboardEntryResponse[]> {
    const limit = Math.min(n, 20);
    const cacheKey = CACHE_WARMING_KEYS.leaderboardTopN(
      limit,
      seasonId ?? null,
    );

    const cached =
      await this.cacheManager.get<LeaderboardEntryResponse[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for top ${limit}: ${cacheKey}`);
      return cached;
    }

    const qb = this.leaderboardRepository
      .createQueryBuilder('entry')
      .leftJoinAndSelect('entry.user', 'user');

    if (seasonId) {
      qb.where('entry.season_id = :seasonId', { seasonId });
      qb.orderBy('entry.season_points', 'DESC');
    } else {
      qb.where('entry.season_id IS NULL');
      qb.orderBy('entry.reputation_score', 'DESC');
    }

    qb.addOrderBy('entry.rank', 'ASC').take(limit);

    const entries = await qb.getMany();

    const data = entries.map((entry) => {
      const accuracyRate =
        entry.total_predictions > 0
          ? (
              (entry.correct_predictions / entry.total_predictions) *
              100
            ).toFixed(1)
          : '0.0';

      return {
        rank: entry.rank,
        user_id: entry.user_id,
        username: entry.user?.username ?? null,
        stellar_address: entry.user?.stellar_address ?? '',
        reputation_score: entry.reputation_score,
        accuracy_rate: accuracyRate,
        total_winnings_stroops: entry.total_winnings_stroops,
        season_points: entry.season_points,
      };
    });

    await this.cacheManager.set(cacheKey, data, this.CACHE_TTL_MS);
    this.logger.debug(`Cached top ${limit} leaderboard: ${cacheKey}`);

    return data;
  }

  /**
   * Invalidate all cached leaderboard cursor pages for a season
   */
  private async invalidateLeaderboardCache(seasonId?: string): Promise<void> {
    try {
      const season = seasonId ?? 'all';
      const pageKeys = ['page:0', 'page:1'];

      let invalidatedCount = 0;
      for (const pageKey of pageKeys) {
        const key = `leaderboard:cursor:${season}:${pageKey}`;
        await this.cacheManager.del(key);
        invalidatedCount++;
      }

      if (invalidatedCount > 0) {
        this.logger.log(
          `Invalidated ${invalidatedCount} cached leaderboard pages for season: ${season}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to invalidate leaderboard cache: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Recalculate all leaderboard ranks based on current user stats.
   * Called by the hourly cron job.
   */
  async recalculateRanks(): Promise<void> {
    const start = Date.now();
    this.logger.log('Starting leaderboard rank recalculation...');

    const users = await this.usersService.findAll();

    // Sort users by reputation_score descending for global ranking
    const sorted = [...users].sort(
      (a, b) => b.reputation_score - a.reputation_score,
    );

    await this.dataSource.transaction(async (manager) => {
      for (let i = 0; i < sorted.length; i++) {
        const user = sorted[i];
        const rank = i + 1;

        const existing = await manager
          .createQueryBuilder(LeaderboardEntry, 'entry')
          .where('entry.user_id = :userId AND entry.season_id IS NULL', {
            userId: user.id,
          })
          .getOne();

        if (existing) {
          await manager.update(
            LeaderboardEntry,
            { id: existing.id },
            {
              rank,
              reputation_score: user.reputation_score,
              season_points: user.season_points,
              total_predictions: user.total_predictions,
              correct_predictions: user.correct_predictions,
              total_winnings_stroops: user.total_winnings_stroops,
            },
          );
        } else {
          const entry = manager.create(LeaderboardEntry, {
            user_id: user.id,
            rank,
            reputation_score: user.reputation_score,
            season_points: user.season_points,
            total_predictions: user.total_predictions,
            correct_predictions: user.correct_predictions,
            total_winnings_stroops: user.total_winnings_stroops,
          });
          await manager.save(LeaderboardEntry, entry);
        }
      }
    });

    const elapsed = Date.now() - start;
    this.logger.log(
      `Leaderboard recalculation complete: ${sorted.length} users updated in ${elapsed}ms`,
    );

    await this.invalidateLeaderboardCache();
  }

  /**
   * Get historical leaderboard rankings with optional filters
   */
  async getHistory(
    query: LeaderboardHistoryQueryDto,
  ): Promise<PaginatedLeaderboardHistoryResponse> {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const qb = this.historyRepository
      .createQueryBuilder('history')
      .leftJoinAndSelect('history.user', 'user');

    if (query.date) {
      qb.where('history.snapshot_date = :date', { date: query.date });
    }

    if (query.season_id) {
      qb.andWhere('history.season_id = :season_id', {
        season_id: query.season_id,
      });
    } else if (!query.date) {
      qb.andWhere('history.season_id IS NULL');
    }

    if (query.user_id) {
      qb.andWhere('history.user_id = :user_id', { user_id: query.user_id });
    }

    qb.orderBy('history.snapshot_date', 'DESC')
      .addOrderBy('history.rank', 'ASC')
      .skip(skip)
      .take(limit);

    const [entries, total] = await qb.getManyAndCount();

    const data: LeaderboardHistoryEntryResponse[] = await Promise.all(
      entries.map(async (entry) => {
        const accuracyRate =
          entry.total_predictions > 0
            ? (
                (entry.correct_predictions / entry.total_predictions) *
                100
              ).toFixed(1)
            : '0.0';

        // Calculate rank change if user_id is specified
        let rankChange: number | null = null;
        if (query.user_id) {
          const previousEntry = await this.historyRepository.findOne({
            where: {
              user_id: entry.user_id,
              snapshot_date: LessThan(entry.snapshot_date),
              season_id: entry.season_id ?? undefined,
            },
            order: { snapshot_date: 'DESC' },
          });

          if (previousEntry) {
            rankChange = previousEntry.rank - entry.rank;
          }
        }

        return {
          rank: entry.rank,
          user_id: entry.user_id,
          username: entry.user?.username ?? null,
          stellar_address: entry.user?.stellar_address ?? '',
          reputation_score: entry.reputation_score,
          accuracy_rate: accuracyRate,
          total_winnings_stroops: entry.total_winnings_stroops,
          season_points: entry.season_points,
          snapshot_date: entry.snapshot_date,
          rank_change: rankChange,
        };
      }),
    );

    return { data, total, page, limit };
  }

  /**
   * Get user rank and stats by stellar address
   * Returns 404 if user has no leaderboard entry
   */
  async getUserRank(stellarAddress: string): Promise<UserRankDto> {
    let user: User | undefined;
    try {
      user = await this.usersService.findByAddress(stellarAddress);
    } catch {
      throw new NotFoundException(
        `User with address "${stellarAddress}" not found`,
      );
    }

    const entry = await this.leaderboardRepository.findOne({
      where: { user_id: user.id, season_id: IsNull() },
    });

    if (!entry) {
      throw new NotFoundException(
        `No leaderboard entry found for user "${stellarAddress}"`,
      );
    }

    const accuracyRate =
      entry.total_predictions > 0
        ? ((entry.correct_predictions / entry.total_predictions) * 100).toFixed(
            1,
          )
        : '0.0';

    return {
      rank: entry.rank,
      reputation_score: entry.reputation_score,
      season_points: entry.season_points,
      total_predictions: entry.total_predictions,
      correct_predictions: entry.correct_predictions,
      accuracy_rate: accuracyRate,
      total_winnings_stroops: entry.total_winnings_stroops,
    };
  }

  /**
   * Create daily snapshot of current leaderboard
   * Called by the daily cron job
   */
  async createDailySnapshot(): Promise<void> {
    const start = Date.now();
    this.logger.log('Creating daily leaderboard snapshot...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const entries = await this.leaderboardRepository.find({
      relations: ['user'],
    });

    await this.dataSource.transaction(async (manager) => {
      for (const entry of entries) {
        const existing = await manager.findOne(LeaderboardHistory, {
          where: {
            user_id: entry.user_id,
            snapshot_date: today,
            season_id: entry.season_id ?? undefined,
          },
        });

        if (!existing) {
          const history = manager.create(LeaderboardHistory, {
            user_id: entry.user_id,
            snapshot_date: today,
            rank: entry.rank,
            reputation_score: entry.reputation_score,
            season_points: entry.season_points,
            total_predictions: entry.total_predictions,
            correct_predictions: entry.correct_predictions,
            total_winnings_stroops: entry.total_winnings_stroops,
            season_id: entry.season_id ?? undefined,
          });
          await manager.save(LeaderboardHistory, history);
        }
      }
    });

    const elapsed = Date.now() - start;
    this.logger.log(
      `Daily snapshot complete: ${entries.length} entries saved in ${elapsed}ms`,
    );
  }

  /**
   * Get user history snapshots for a specific Stellar address
   */
  async getHistoryForAddress(address: string, days: number = 30) {
    const validDays = Math.min(Math.max(days || 30, 1), 90);

    const user = await this.usersService.findByAddress(address);
    if (!user) {
      throw new NotFoundException(`User with address ${address} not found`);
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - validDays);

    const history = await this.historyRepository.find({
      where: {
        user_id: user.id,
        snapshot_date: MoreThanOrEqual(cutoffDate),
      },
      order: { snapshot_date: 'DESC' },
    });

    return history.map((h) => ({
      snapshot_date: h.snapshot_date,
      rank: h.rank,
      reputation_score: h.reputation_score,
      season_points: h.season_points,
    }));
  }
}
