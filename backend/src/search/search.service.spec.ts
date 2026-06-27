// backend/src/search/search.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SelectQueryBuilder } from 'typeorm';
import { Market } from '../markets/entities/market.entity';
import { User } from '../users/entities/user.entity';
import {
  Competition,
  CompetitionVisibility,
} from '../competitions/entities/competition.entity';
import { SearchService } from './search.service';
import { GlobalSearchDto, SearchType } from './dto/global-search.dto';

type MockQb<T> = jest.Mocked<
  Pick<
    SelectQueryBuilder<T>,
    | 'addSelect'
    | 'select'
    | 'where'
    | 'andWhere'
    | 'setParameter'
    | 'orderBy'
    | 'skip'
    | 'take'
    | 'getMany'
    | 'getManyAndCount'
  >
>;

function makeQb<T>(results: T[]): MockQb<T> {
  const qb = {
    addSelect: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(results),
    getManyAndCount: jest.fn().mockResolvedValue([results, results.length]),
  } as unknown as MockQb<T>;
  return qb;
}

describe('SearchService', () => {
  let service: SearchService;
  let marketQb: MockQb<Market>;
  let userQb: MockQb<User>;
  let competitionQb: MockQb<Competition>;

  const mockMarket = {
    id: 'market-1',
    title: 'Bitcoin price prediction',
    description: 'Will BTC hit 100k?',
    category: 'crypto',
    is_resolved: false,
    is_public: true,
    participant_count: 10,
    created_at: new Date('2026-01-01'),
  } as Market;

  const mockUser = {
    id: 'user-1',
    username: 'alice',
    stellar_address: 'GABC123',
    avatar_url: null,
    reputation_score: 42,
    total_predictions: 7,
  } as User;

  const mockCompetition = {
    id: 'comp-1',
    title: 'Crypto League',
    description: 'Monthly crypto competition',
    start_time: new Date('2026-02-01'),
    end_time: new Date('2026-02-28'),
    participant_count: 5,
    visibility: CompetitionVisibility.Public,
  } as unknown as Competition;

  beforeEach(async () => {
    marketQb = makeQb([mockMarket]);
    userQb = makeQb([mockUser]);
    competitionQb = makeQb([mockCompetition]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        {
          provide: getRepositoryToken(Market),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(marketQb) },
        },
        {
          provide: getRepositoryToken(User),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(userQb) },
        },
        {
          provide: getRepositoryToken(Competition),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(competitionQb),
          },
        },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  describe('search()', () => {
    it('short-circuits on empty string without querying any repository', async () => {
      const result = await service.search({
        query: '',
        type: SearchType.All,
        page: 1,
        limit: 20,
      });

      expect(result.total).toBe(0);
      expect(result.markets).toEqual([]);
      expect(result.users).toEqual([]);
      expect(result.competitions).toEqual([]);
      expect(marketQb.getManyAndCount).not.toHaveBeenCalled();
      expect(userQb.getManyAndCount).not.toHaveBeenCalled();
      expect(competitionQb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('short-circuits on single-character query without querying any repository', async () => {
      const result = await service.search({
        query: 'a',
        type: SearchType.All,
        page: 1,
        limit: 20,
      });

      expect(result.total).toBe(0);
      expect(marketQb.getManyAndCount).not.toHaveBeenCalled();
      expect(userQb.getManyAndCount).not.toHaveBeenCalled();
      expect(competitionQb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('returns all three entity types for SearchType.All', async () => {
      const dto: GlobalSearchDto = {
        query: 'bitcoin',
        type: SearchType.All,
        page: 1,
        limit: 20,
      };
      const result = await service.search(dto);

      expect(result.markets).toEqual([mockMarket]);
      expect(result.users).toEqual([mockUser]);
      expect(result.competitions).toEqual([mockCompetition]);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('returns only markets when type is Markets', async () => {
      const dto: GlobalSearchDto = {
        query: 'bitcoin',
        type: SearchType.Markets,
        page: 1,
        limit: 20,
      };
      const result = await service.search(dto);

      expect(result.markets).toEqual([mockMarket]);
      expect(result.users).toEqual([]);
      expect(result.competitions).toEqual([]);
    });

    it('caps limit at 50', async () => {
      const dto: GlobalSearchDto = {
        query: 'test',
        type: SearchType.Markets,
        page: 1,
        limit: 999,
      };
      await service.search(dto);

      expect(marketQb.take).toHaveBeenCalledWith(50);
    });

    it('computes correct skip for page 3 limit 10', async () => {
      const dto: GlobalSearchDto = {
        query: 'test',
        type: SearchType.Markets,
        page: 3,
        limit: 10,
      };
      await service.search(dto);

      expect(marketQb.skip).toHaveBeenCalledWith(20);
      expect(marketQb.take).toHaveBeenCalledWith(10);
    });
  });

  describe('searchMarkets FTS', () => {
    it('filters by is_public = true', async () => {
      await service.search({
        query: 'bitcoin',
        type: SearchType.Markets,
        page: 1,
        limit: 20,
      });

      expect(marketQb.where).toHaveBeenCalledWith(
        'market.is_public = :isPublic',
        { isPublic: true },
      );
    });

    it('matches via search_vector @@ plainto_tsquery', async () => {
      await service.search({
        query: 'bitcoin',
        type: SearchType.Markets,
        page: 1,
        limit: 20,
      });

      expect(marketQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('search_vector @@'),
        expect.objectContaining({ query: 'bitcoin' }),
      );
    });

    it('orders by ts_rank DESC', async () => {
      await service.search({
        query: 'bitcoin',
        type: SearchType.Markets,
        page: 1,
        limit: 20,
      });

      expect(marketQb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('ts_rank'),
        'DESC',
      );
    });
  });

  describe('searchUsers FTS', () => {
    it('filters out banned users', async () => {
      await service.search({
        query: 'alice',
        type: SearchType.Users,
        page: 1,
        limit: 20,
      });

      expect(userQb.where).toHaveBeenCalledWith('user.is_banned = :banned', {
        banned: false,
      });
    });

    it('matches via search_vector @@ plainto_tsquery', async () => {
      await service.search({
        query: 'alice',
        type: SearchType.Users,
        page: 1,
        limit: 20,
      });

      expect(userQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('search_vector @@'),
        expect.objectContaining({ query: 'alice' }),
      );
    });

    it('orders by ts_rank DESC', async () => {
      await service.search({
        query: 'alice',
        type: SearchType.Users,
        page: 1,
        limit: 20,
      });

      expect(userQb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('ts_rank'),
        'DESC',
      );
    });
  });

  describe('searchCompetitions FTS', () => {
    it('filters by visibility = public', async () => {
      await service.search({
        query: 'league',
        type: SearchType.Competitions,
        page: 1,
        limit: 20,
      });

      expect(competitionQb.where).toHaveBeenCalledWith(
        'competition.visibility = :visibility',
        { visibility: CompetitionVisibility.Public },
      );
    });

    it('matches via search_vector @@ plainto_tsquery', async () => {
      await service.search({
        query: 'league',
        type: SearchType.Competitions,
        page: 1,
        limit: 20,
      });

      expect(competitionQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('search_vector @@'),
        expect.objectContaining({ query: 'league' }),
      );
    });

    it('orders by ts_rank DESC', async () => {
      await service.search({
        query: 'league',
        type: SearchType.Competitions,
        page: 1,
        limit: 20,
      });

      expect(competitionQb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('ts_rank'),
        'DESC',
      );
    });
  });
});
