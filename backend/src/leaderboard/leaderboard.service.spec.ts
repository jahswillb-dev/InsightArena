import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { LeaderboardHistory } from './entities/leaderboard-history.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { SeasonsService } from '../seasons/seasons.service';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';

describe('LeaderboardService', () => {
  let service: LeaderboardService;

  const mockUser: Partial<User> = {
    id: 'user-uuid-1',
    stellar_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
    username: 'testuser',
    reputation_score: 100,
    season_points: 50,
    total_predictions: 10,
    correct_predictions: 7,
    total_winnings_stroops: '500000',
  };

  const mockEntry: Partial<LeaderboardEntry> = {
    id: 'entry-uuid-1',
    user_id: 'user-uuid-1',
    user: mockUser as User,
    rank: 1,
    reputation_score: 100,
    season_points: 50,
    total_predictions: 10,
    correct_predictions: 7,
    total_winnings_stroops: '500000',
  };

  const mockQb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
    getMany: jest.fn(),
    getOne: jest.fn(),
  };

  const mockEntryRepository = {
    createQueryBuilder: jest.fn(() => mockQb),
    findOne: jest.fn(),
  };

  const mockHistoryRepository = {
    createQueryBuilder: jest.fn(() => mockQb),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockUsersService = {
    findAll: jest.fn(),
    findByAddress: jest.fn(),
  };

  const mockSeasonsService = {
    findActive: jest.fn(),
  };

  const mockDataSource = {
    transaction: jest.fn(),
  };

  const mockCacheManager = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaderboardService,
        {
          provide: getRepositoryToken(LeaderboardEntry),
          useValue: mockEntryRepository,
        },
        {
          provide: getRepositoryToken(LeaderboardHistory),
          useValue: mockHistoryRepository,
        },
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
        {
          provide: SeasonsService,
          useValue: mockSeasonsService,
        },
        {
          provide: getDataSourceToken(),
          useValue: mockDataSource,
        },
        {
          provide: CACHE_MANAGER,
          useValue: mockCacheManager,
        },
      ],
    }).compile();

    service = module.get<LeaderboardService>(LeaderboardService);
    jest.clearAllMocks();
    mockEntryRepository.createQueryBuilder.mockReturnValue(mockQb);
    mockQb.leftJoinAndSelect.mockReturnThis();
    mockQb.where.mockReturnThis();
    mockQb.orderBy.mockReturnThis();
    mockQb.addOrderBy.mockReturnThis();
    mockQb.skip.mockReturnThis();
    mockQb.take.mockReturnThis();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getLeaderboard', () => {
    it('should return global all-time leaderboard ordered by reputation_score', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[mockEntry], 1]);
      const query: LeaderboardQueryDto = { page: 1, limit: 20 };

      const result = await service.getLeaderboard(query);

      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[0].reputation_score).toBe(100);
      expect(mockQb.where).toHaveBeenCalledWith('entry.season_id IS NULL');
      expect(mockQb.orderBy).toHaveBeenCalledWith(
        'entry.reputation_score',
        'DESC',
      );
    });

    it('should filter by season_id and order by season_points', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[mockEntry], 1]);
      const query: LeaderboardQueryDto = {
        page: 1,
        limit: 20,
        season_id: 'season-1',
      };

      await service.getLeaderboard(query);

      expect(mockQb.where).toHaveBeenCalledWith(
        'entry.season_id = :season_id',
        {
          season_id: 'season-1',
        },
      );
      expect(mockQb.orderBy).toHaveBeenCalledWith(
        'entry.season_points',
        'DESC',
      );
    });

    it('should compute accuracy_rate correctly', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[mockEntry], 1]);

      const result = await service.getLeaderboard({ page: 1, limit: 20 });

      // 7/10 * 100 = 70.0
      expect(result.data[0].accuracy_rate).toBe('70.0');
    });

    it('should return accuracy_rate of 0.0 when no predictions', async () => {
      const entryNoPredictions = {
        ...mockEntry,
        total_predictions: 0,
        correct_predictions: 0,
      };
      mockQb.getManyAndCount.mockResolvedValue([[entryNoPredictions], 1]);

      const result = await service.getLeaderboard({ page: 1, limit: 20 });

      expect(result.data[0].accuracy_rate).toBe('0.0');
    });

    it('should cap limit at 100', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.getLeaderboard({ page: 1, limit: 999 });

      expect(mockQb.take).toHaveBeenCalledWith(100);
    });
  });

  describe('getTopLeaderboard', () => {
    it('should return top entries for the active season and cap at 20', async () => {
      mockSeasonsService.findActive.mockResolvedValue({ id: 'season-1' });
      mockQb.getManyAndCount.mockResolvedValue([[mockEntry], 1]);

      const result = await service.getTopLeaderboard(50);

      expect(mockSeasonsService.findActive).toHaveBeenCalled();
      expect(mockQb.where).toHaveBeenCalledWith('entry.season_id = :season_id', {
        season_id: 'season-1',
      });
      expect(mockQb.take).toHaveBeenCalledWith(20);
      expect(result).toHaveLength(1);
      expect(result[0].rank).toBe(1);
    });
  });

  describe('recalculateRanks', () => {
    it('should sort users by reputation_score and run in a transaction', async () => {
      const users = [
        { ...mockUser, id: 'u1', reputation_score: 50 },
        { ...mockUser, id: 'u2', reputation_score: 100 },
      ];
      mockUsersService.findAll.mockResolvedValue(users);
      mockDataSource.transaction.mockResolvedValue(undefined);

      await service.recalculateRanks();

      expect(mockUsersService.findAll).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe('getTopN', () => {
    it('should return top N entries and cap at 20', async () => {
      const entries = Array.from({ length: 20 }, (_, i) => ({
        ...mockEntry,
        rank: i + 1,
      }));
      mockQb.getMany.mockResolvedValue(entries);
      mockCacheManager.get.mockResolvedValue(null);

      const result = await service.getTopN(25);

      expect(result).toHaveLength(20);
      expect(result[0].rank).toBe(1);
      expect(result[19].rank).toBe(20);
      expect(mockQb.take).toHaveBeenCalledWith(20);
      expect(mockCacheManager.set).toHaveBeenCalledWith(
        'leaderboard:top:20:all',
        expect.any(Array),
        expect.any(Number),
      );
    });

    it('should return cache hit without DB query', async () => {
      const cached = [{ rank: 1 }] as any[];
      mockCacheManager.get.mockResolvedValue(cached);

      const result = await service.getTopN(5);

      expect(result).toBe(cached);
      expect(mockEntryRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should filter by season_id when provided', async () => {
      const entries = [{ ...mockEntry, rank: 1 }];
      mockQb.getMany.mockResolvedValue(entries);
      mockCacheManager.get.mockResolvedValue(null);

      const result = await service.getTopN(5, 'season-1');

      expect(result).toHaveLength(1);
      expect(mockQb.where).toHaveBeenCalledWith('entry.season_id = :seasonId', {
        seasonId: 'season-1',
      });
    });
  });

  describe('getUserRank', () => {
    it('should return user rank and stats by stellar address', async () => {
      mockUsersService.findByAddress = jest
        .fn()
        .mockResolvedValue(mockUser as User);
      mockEntryRepository.findOne = jest
        .fn()
        .mockResolvedValue(mockEntry as LeaderboardEntry);

      const result = await service.getUserRank(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
      );

      expect(result.rank).toBe(1);
      expect(result.reputation_score).toBe(100);
      expect(result.accuracy_rate).toBe('70.0');
      expect(mockUsersService.findByAddress).toHaveBeenCalledWith(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
      );
    });

    it('should throw NotFoundException if user not found', async () => {
      mockUsersService.findByAddress = jest
        .fn()
        .mockRejectedValue(new Error('User not found'));

      await expect(service.getUserRank('INVALID_ADDRESS')).rejects.toThrow(
        'User with address',
      );
    });

    it('should throw NotFoundException if no leaderboard entry', async () => {
      mockUsersService.findByAddress = jest
        .fn()
        .mockResolvedValue(mockUser as User);
      mockEntryRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(
        service.getUserRank('GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN'),
      ).rejects.toThrow('No leaderboard entry found');
    });

    it('should compute accuracy_rate correctly for getUserRank', async () => {
      mockUsersService.findByAddress = jest
        .fn()
        .mockResolvedValue(mockUser as User);
      mockEntryRepository.findOne = jest
        .fn()
        .mockResolvedValue(mockEntry as LeaderboardEntry);

      const result = await service.getUserRank(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
      );

      expect(result.accuracy_rate).toBe('70.0');
    });
  });
});
