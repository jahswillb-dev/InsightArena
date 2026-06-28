import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from '../analytics/analytics.service';
import { MarketStatus } from '../markets/dto/list-markets.dto';
import { MarketsService } from '../markets/markets.service';
import { CACHE_WARMING_KEYS } from './cache-warming.keys';
import { CacheWarmingService } from './warming.service';

describe('CacheWarmingService', () => {
  let service: CacheWarmingService;
  let cacheManager: { set: jest.Mock };
  let marketsService: {
    findAllFiltered: jest.Mock;
    getTrendingMarkets: jest.Mock;
    findByIdOrOnChainId: jest.Mock;
  };
  let analyticsService: { getCategoryAnalytics: jest.Mock };

  beforeEach(async () => {
    cacheManager = { set: jest.fn().mockResolvedValue(undefined) };
    marketsService = {
      findAllFiltered: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      getTrendingMarkets: jest.fn().mockResolvedValue({
        data: [{ id: 'popular-1' }, { id: 'popular-2' }],
        total: 2,
      }),
      findByIdOrOnChainId: jest
        .fn()
        .mockImplementation((id: string) => Promise.resolve({ id })),
    };
    analyticsService = {
      getCategoryAnalytics: jest.fn().mockResolvedValue({ categories: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheWarmingService,
        { provide: CACHE_MANAGER, useValue: cacheManager },
        { provide: MarketsService, useValue: marketsService },
        { provide: AnalyticsService, useValue: analyticsService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const values: Record<string, string> = {
                CACHE_WARMING_TTL_SECONDS: '300',
                CACHE_WARMING_ACTIVE_EVENTS_LIMIT: '10',
                CACHE_WARMING_TRENDING_EVENTS_LIMIT: '8',
                CACHE_WARMING_POPULAR_EVENT_DETAILS_LIMIT: '2',
              };
              return values[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get(CacheWarmingService);
  });

  it('warms active events, trending events, platform statistics, and popular details', async () => {
    const result = await service.warmFrequentlyAccessedData();

    expect(marketsService.findAllFiltered).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      status: MarketStatus.Open,
      is_public: true,
    });
    expect(marketsService.getTrendingMarkets).toHaveBeenCalledWith({
      page: 1,
      limit: 8,
    });
    expect(analyticsService.getCategoryAnalytics).toHaveBeenCalled();
    expect(marketsService.findByIdOrOnChainId).toHaveBeenCalledWith(
      'popular-1',
    );
    expect(marketsService.findByIdOrOnChainId).toHaveBeenCalledWith(
      'popular-2',
    );
    expect(cacheManager.set).toHaveBeenCalledWith(
      CACHE_WARMING_KEYS.activeEvents,
      { data: [], total: 0 },
      300000,
    );

    expect(cacheManager.set).toHaveBeenCalledWith(
      CACHE_WARMING_KEYS.trendingEvents,
      {
        data: [
          { id: 'popular-1' },
          { id: 'popular-2' },
        ],
        total: 2,
      },
      300000,
    );

    // At least one popular market detail key
    expect(cacheManager.set).toHaveBeenCalledWith(
      CACHE_WARMING_KEYS.popularEventDetail('popular-1'),
      { id: 'popular-1' },
      300000,
    );

    // Platform statistics (if applicable)
    expect(cacheManager.set).toHaveBeenCalledWith(
      CACHE_WARMING_KEYS.platformStatistics,
      { categories: [] },
      300000,
    );
    expect(result.failed).toEqual([]);
    expect(result.warmed).toEqual(
      expect.arrayContaining([
        CACHE_WARMING_KEYS.activeEvents,
        CACHE_WARMING_KEYS.trendingEvents,
        CACHE_WARMING_KEYS.platformStatistics,
        CACHE_WARMING_KEYS.popularEventDetail('popular-1'),
        CACHE_WARMING_KEYS.popularEventDetail('popular-2'),
      ]),
    );
  });

  it('continues warming other keys when one loader fails', async () => {
    marketsService.findAllFiltered.mockRejectedValueOnce(new Error('db down'));

    const result = await service.warmFrequentlyAccessedData();

    expect(result.failed).toEqual([
      { key: CACHE_WARMING_KEYS.activeEvents, reason: 'db down' },
    ]);
    expect(result.warmed).toContain(CACHE_WARMING_KEYS.trendingEvents);
    expect(result.warmed).toContain(CACHE_WARMING_KEYS.platformStatistics);
  });

  it('skips warming when disabled by config', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheWarmingService,
        { provide: CACHE_MANAGER, useValue: cacheManager },
        { provide: MarketsService, useValue: marketsService },
        { provide: AnalyticsService, useValue: analyticsService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => 'false') },
        },
      ],
    }).compile();

    const disabledService = module.get(CacheWarmingService);
    const result = await disabledService.warmFrequentlyAccessedData();

    expect(result).toEqual({ warmed: [], failed: [] });
    expect(cacheManager.set).not.toHaveBeenCalled();
  });
});
