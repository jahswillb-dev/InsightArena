/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AdminService } from './admin.service';
import { VerifiedAddress } from './entities/verified-address.entity';
import { ListVerifiedAddressesQueryDto } from './dto/list-verified-addresses-query.dto';

describe('AdminService (Verified Addresses)', () => {
  let service: AdminService;
  let verifiedAddressRepo: any;

  const mockAddresses = [
    {
      id: 'v1',
      address: 'GABC123',
      verified_by: 'GADMIN',
      verified_at: new Date('2026-01-01T10:00:00Z'),
      events_created: 3,
    },
    {
      id: 'v2',
      address: 'GDEF456',
      verified_by: 'GADMIN',
      verified_at: new Date('2026-01-02T10:00:00Z'),
      events_created: 1,
    },
  ] as VerifiedAddress[];

  function createMockQueryBuilder(returnValue: any): any {
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
    };
  }

  beforeEach(async () => {
    verifiedAddressRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      find: jest.fn(),
      findByIds: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,

        {
          provide: getRepositoryToken(VerifiedAddress),
          useValue: verifiedAddressRepo,
        },
        {
          provide: getRepositoryToken(
            require('../users/entities/user.entity').User,
          ),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
        },

        {
          provide: getRepositoryToken(
            require('../markets/entities/market.entity').Market,
          ),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(
            require('../markets/entities/comment.entity').Comment,
          ),
          useValue: { findOne: jest.fn() },
        },

        {
          provide: getRepositoryToken(
            require('../predictions/entities/prediction.entity').Prediction,
          ),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(
            require('../competitions/entities/competition.entity').Competition,
          ),
          useValue: { findOne: jest.fn() },
        },

        {
          provide: getRepositoryToken(
            require('../competitions/entities/competition-participant.entity')
              .CompetitionParticipant,
          ),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(
            require('../analytics/entities/activity-log.entity').ActivityLog,
          ),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(
            require('../flags/entities/flag.entity').Flag,
          ),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(
            require('../matches/entities/creator-event.entity').CreatorEvent,
          ),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(
            require('../indexer/entities/fee-history.entity').FeeHistory,
          ),
          useValue: { findOne: jest.fn(), find: jest.fn() },
        },
        {
          provide: require('../analytics/analytics.service').AnalyticsService,
          useValue: { logActivity: jest.fn() },
        },
        {
          provide: require('../notifications/notifications.service')
            .NotificationsService,
          useValue: { create: jest.fn() },
        },

        {
          provide: require('../soroban/soroban.service').SorobanService,
          useValue: {
            resolveMarket: jest.fn(),
            refundCompetitionParticipant: jest.fn(),
          },
        },
        {
          provide: require('../flags/flags.service').FlagsService,
          useValue: { listFlags: jest.fn(), resolveFlag: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  describe('listVerifiedAddresses', () => {
    it('should return paginated verified addresses', async () => {
      const qb = createMockQueryBuilder([mockAddresses, 2]);
      verifiedAddressRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listVerifiedAddresses(
        new ListVerifiedAddressesQueryDto(),
      );

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('should search by address when search param is provided', async () => {
      const qb = createMockQueryBuilder([[mockAddresses[0]], 1]);
      verifiedAddressRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listVerifiedAddresses({
        page: 1,
        limit: 20,
        search: 'GABC',
      });

      expect(qb.where).toHaveBeenCalledWith('v.address ILIKE :search', {
        search: '%GABC%',
      });
    });

    it('should return correct response shape', async () => {
      const qb = createMockQueryBuilder([mockAddresses, 2]);
      verifiedAddressRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listVerifiedAddresses(
        new ListVerifiedAddressesQueryDto(),
      );

      expect(result).toEqual({
        data: [
          {
            address: 'GABC123',
            verified_at: mockAddresses[0].verified_at.toISOString(),
            verified_by: 'GADMIN',
            events_created: 3,
          },
          {
            address: 'GDEF456',
            verified_at: mockAddresses[1].verified_at.toISOString(),
            verified_by: 'GADMIN',
            events_created: 1,
          },
        ],
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('should handle empty results', async () => {
      const qb = createMockQueryBuilder([[], 0]);
      verifiedAddressRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listVerifiedAddresses(
        new ListVerifiedAddressesQueryDto(),
      );

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('should sort by verified_at descending by default', async () => {
      const qb = createMockQueryBuilder([mockAddresses, 2]);
      verifiedAddressRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listVerifiedAddresses(new ListVerifiedAddressesQueryDto());

      expect(qb.orderBy).toHaveBeenCalledWith('v.verified_at', 'DESC');
    });

    it('should handle pagination parameters', async () => {
      const qb = createMockQueryBuilder([mockAddresses, 2]);
      verifiedAddressRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listVerifiedAddresses({
        page: 2,
        limit: 10,
        search: undefined,
      });

      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
    });
  });
  describe('banUser and unbanUser', () => {
    let userRepository: any;

    beforeEach(() => {
      userRepository = service['usersRepository'];
    });

    it('should throw ConflictException if user is already banned', async () => {
      userRepository.findOne.mockResolvedValue({ id: 'u1', is_banned: true });
      await expect(service.banUser('u1', 'reason', 'admin')).rejects.toThrow(
        'User is already banned',
      );
    });

    it('should throw BadRequestException if user is not banned', async () => {
      userRepository.findOne.mockResolvedValue({ id: 'u1', is_banned: false });
      await expect(service.unbanUser('u1', 'admin')).rejects.toThrow(
        'User is not banned',
      );
    });
  });
});
