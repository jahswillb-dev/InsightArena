import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { OracleService } from './oracle.service';
import { CreatorEventMatch } from '../creator-events/entities/creator-event-match.entity';
import { CreatorEvent } from '../creator-events/entities/creator-event.entity';
import { ListPendingMatchesQueryDto } from './dto/list-pending-matches-query.dto';

type MockRepo = jest.Mocked<
  Pick<Repository<any>, 'findOne' | 'createQueryBuilder' | 'find' | 'findByIds'>
>;

function createMockQueryBuilder<T>(
  returnValue: any,
): Partial<SelectQueryBuilder<T>> {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue(returnValue),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    select: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
  } as unknown as Partial<SelectQueryBuilder<T>>;
}

describe('OracleService', () => {
  let service: OracleService;
  let matchRepo: MockRepo;
  let eventRepo: MockRepo;

  const mockEvent = {
    id: 'event-1',
    on_chain_event_id: '1',
    title: 'World Cup Final',
    creator_address: 'GCREATOR',
  } as CreatorEvent;

  const mockMatches = [
    {
      id: 'match-1',
      on_chain_match_id: '101',
      event_id: 'event-1',
      team_a: 'Team Alpha',
      team_b: 'Team Beta',
      match_time: new Date('2026-01-01T08:00:00Z'),
      result_submitted: false,
      prediction_count: 15,
      created_at: new Date('2025-12-25T10:00:00Z'),
    },
    {
      id: 'match-2',
      on_chain_match_id: '102',
      event_id: 'event-1',
      team_a: 'Team Gamma',
      team_b: 'Team Delta',
      match_time: new Date('2026-01-01T09:00:00Z'),
      result_submitted: false,
      prediction_count: 10,
      created_at: new Date('2025-12-25T11:00:00Z'),
    },
  ] as CreatorEventMatch[];

  beforeEach(async () => {
    matchRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      find: jest.fn(),
      findByIds: jest.fn(),
    };

    eventRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      find: jest.fn(),
      findByIds: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: getRepositoryToken(CreatorEventMatch), useValue: matchRepo },
        { provide: getRepositoryToken(CreatorEvent), useValue: eventRepo },
      ],
    }).compile();

    service = module.get<OracleService>(OracleService);
    eventRepo.find.mockResolvedValue([mockEvent]);
  });

  describe('getPendingMatches', () => {
    it('should return only matches that have started and not been resolved', async () => {
      const qb = createMockQueryBuilder<CreatorEvent>([mockMatches, 2]);
      matchRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<CreatorEvent>,
      );

      const result = await service.getPendingMatches(
        new ListPendingMatchesQueryDto(),
      );

      expect(qb.where).toHaveBeenCalledWith(
        'm.match_time < :now',
        expect.any(Object),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'm.result_submitted = :submitted',
        { submitted: false },
      );
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should exclude future matches and already-submitted matches', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const oneHourLater = new Date(now.getTime() + 3600000);

      const pastUnsubmittedMatch = {
        id: 'match-past-unsubmitted',
        on_chain_match_id: '201',
        event_id: 'event-1',
        team_a: 'Team A',
        team_b: 'Team B',
        match_time: oneHourAgo,
        result_submitted: false,
        prediction_count: 5,
        created_at: new Date(oneHourAgo.getTime() - 86400000),
      } as CreatorEventMatch;

      const pastSubmittedMatch = {
        id: 'match-past-submitted',
        on_chain_match_id: '202',
        event_id: 'event-1',
        team_a: 'Team C',
        team_b: 'Team D',
        match_time: oneHourAgo,
        result_submitted: true,
        prediction_count: 10,
        created_at: new Date(oneHourAgo.getTime() - 86400000),
      } as CreatorEventMatch;

      const futureUnsubmittedMatch = {
        id: 'match-future-unsubmitted',
        on_chain_match_id: '203',
        event_id: 'event-1',
        team_a: 'Team E',
        team_b: 'Team F',
        match_time: oneHourLater,
        result_submitted: false,
        prediction_count: 8,
        created_at: new Date(),
      } as CreatorEventMatch;

      const futureSubmittedMatch = {
        id: 'match-future-submitted',
        on_chain_match_id: '204',
        event_id: 'event-1',
        team_a: 'Team G',
        team_b: 'Team H',
        match_time: oneHourLater,
        result_submitted: true,
        prediction_count: 12,
        created_at: new Date(),
      } as CreatorEventMatch;

      const qb = createMockQueryBuilder<CreatorEvent>([
        [pastUnsubmittedMatch],
        1,
      ]);
      matchRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<CreatorEvent>,
      );

      const result = await service.getPendingMatches(
        new ListPendingMatchesQueryDto(),
      );

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].match.id).toBe('match-past-unsubmitted');
      expect(result.data[0].match.result_submitted).toBe(false);

      expect(qb.where).toHaveBeenCalledWith(
        'm.match_time < :now',
        expect.any(Object),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'm.result_submitted = :submitted',
        { submitted: false },
      );
    });

    it('should calculate time_since_match_started_seconds correctly and non-negative', async () => {
      const now = new Date();
      const fiftySecondsAgo = new Date(now.getTime() - 50000);

      const recentMatch = {
        id: 'match-recent',
        on_chain_match_id: '205',
        event_id: 'event-1',
        team_a: 'Team I',
        team_b: 'Team J',
        match_time: fiftySecondsAgo,
        result_submitted: false,
        prediction_count: 3,
        created_at: new Date(fiftySecondsAgo.getTime() - 3600000),
      } as CreatorEventMatch;

      const qb = createMockQueryBuilder<CreatorEvent>([[recentMatch], 1]);
      matchRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<CreatorEvent>,
      );

      const result = await service.getPendingMatches(
        new ListPendingMatchesQueryDto(),
      );

      expect(result.data).toHaveLength(1);
      const timeSinceStarted = result.data[0].time_since_match_started_seconds;
      expect(timeSinceStarted).toBeGreaterThanOrEqual(0);
      expect(timeSinceStarted).toBeLessThanOrEqual(60);
    });

    it('should return empty array when no pending matches', async () => {
      const qb = createMockQueryBuilder<CreatorEvent>([[], 0]);
      matchRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<CreatorEvent>,
      );

      const result = await service.getPendingMatches(
        new ListPendingMatchesQueryDto(),
      );

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should sort matches by match_time ascending (oldest first)', async () => {
      const qb = createMockQueryBuilder<CreatorEvent>([mockMatches, 2]);
      matchRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<CreatorEvent>,
      );

      await service.getPendingMatches(new ListPendingMatchesQueryDto());

      expect(qb.orderBy).toHaveBeenCalledWith('m.match_time', 'ASC');
    });

    it('should include event details in response', async () => {
      const qb = createMockQueryBuilder<CreatorEvent>([mockMatches, 2]);
      matchRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<CreatorEvent>,
      );

      const result = await service.getPendingMatches(
        new ListPendingMatchesQueryDto(),
      );

      expect(result.data[0].event.title).toBe('World Cup Final');
      expect(result.data[0].event.creator_address).toBe('GCREATOR');
      expect(result.data[0].match.team_a).toBe('Team Alpha');
      expect(result.data[0].match.team_b).toBe('Team Beta');
    });

    it('should include time_since_match_started_seconds', async () => {
      const qb = createMockQueryBuilder<CreatorEvent>([mockMatches, 2]);
      matchRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<CreatorEvent>,
      );

      const result = await service.getPendingMatches(
        new ListPendingMatchesQueryDto(),
      );

      expect(result.data[0].time_since_match_started_seconds).toBeGreaterThan(
        0,
      );
    });

    it('should handle pagination', async () => {
      const qb = createMockQueryBuilder<CreatorEvent>([mockMatches, 2]);
      matchRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<CreatorEvent>,
      );

      const result = await service.getPendingMatches({ page: 1, limit: 5 });

      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(5);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(5);
    });
  });
});
