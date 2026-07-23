import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { LeaderboardScheduler } from './leaderboard.scheduler';
import { LeaderboardService } from './leaderboard.service';

describe('LeaderboardScheduler', () => {
  let scheduler: LeaderboardScheduler;
  let service: LeaderboardService;

  const mockSchedulerRegistry = {
    addCronJob: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaderboardScheduler,
        {
          provide: LeaderboardService,
          useValue: {
            recalculateRanks: jest.fn(),
            createRankSnapshot: jest.fn(),
            pruneSnapshots: jest.fn(),
          },
        },
        {
          provide: SchedulerRegistry,
          useValue: mockSchedulerRegistry,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    scheduler = module.get<LeaderboardScheduler>(LeaderboardScheduler);
    service = module.get<LeaderboardService>(LeaderboardService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(scheduler).toBeDefined();
  });

  describe('handleHourlyRecalculation', () => {
    it('should call recalculateRanks', async () => {
      const spy = jest.spyOn(service, 'recalculateRanks').mockResolvedValue();

      await scheduler.handleHourlyRecalculation();

      expect(spy).toHaveBeenCalled();
    });

    it('should not throw if recalculateRanks fails', async () => {
      jest
        .spyOn(service, 'recalculateRanks')
        .mockRejectedValue(new Error('DB error'));

      await expect(
        scheduler.handleHourlyRecalculation(),
      ).resolves.not.toThrow();
    });
  });

  describe('onModuleInit', () => {
    it('should register the rank snapshot cron job using the configured expression', () => {
      mockConfigService.get.mockReturnValue('*/15 * * * *');

      scheduler.onModuleInit();

      expect(mockConfigService.get).toHaveBeenCalledWith(
        'LEADERBOARD_SNAPSHOT_CRON',
        '0 * * * *',
      );
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'leaderboard-rank-snapshot',
        expect.anything(),
      );
    });
  });

  describe('handleRankSnapshot', () => {
    it('should create a snapshot then prune old ones', async () => {
      const createSpy = jest
        .spyOn(service, 'createRankSnapshot')
        .mockResolvedValue();
      const pruneSpy = jest
        .spyOn(service, 'pruneSnapshots')
        .mockResolvedValue();

      await scheduler.handleRankSnapshot();

      expect(createSpy).toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalled();
    });
  });
});
