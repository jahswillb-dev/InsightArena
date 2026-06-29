import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { Notification, NotificationType } from './entities/notification.entity';
import { NotificationBroadcasterService } from '../websocket/notification-broadcaster.service';
import { EventsGateway } from '../websocket/events.gateway';

describe('NotificationsService', () => {
  let service: NotificationsService;

  const mockNotification: Partial<Notification> = {
    id: 1,
    user_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
    type: NotificationType.EventCreated,
    title: 'Test',
    message: 'Test message',
    read: false,
    created_at: new Date('2024-01-01'),
  };

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    findOne: jest.fn(),
  };

  const mockServer = {
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
  };

  const mockGateway = {
    server: mockServer,
  };

  const mockNotificationBroadcaster = {
    broadcastNewNotification: jest.fn(),
    broadcastNotificationRead: jest.fn(),
    onModuleDestroy: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getRepositoryToken(Notification),
          useValue: mockRepository,
        },
        {
          provide: NotificationBroadcasterService,
          useValue: mockNotificationBroadcaster,
        },
        {
          provide: EventsGateway,
          useValue: mockGateway,
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create and save a notification', async () => {
      mockRepository.create.mockReturnValue(mockNotification);
      mockRepository.save.mockResolvedValue(mockNotification);

      const result = await service.create(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
        NotificationType.EventCreated,
        'Test',
        'Test message',
      );

      expect(mockRepository.create).toHaveBeenCalledWith({
        user_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
        type: NotificationType.EventCreated,
        title: 'Test',
        message: 'Test message',
        data: null,
      });
      expect(result).toEqual(mockNotification);
      expect(
        mockNotificationBroadcaster.broadcastNewNotification,
      ).toHaveBeenCalled();
    });

    it('should pass data when provided', async () => {
      const data = { key: 'value' };
      mockRepository.create.mockReturnValue(mockNotification);
      mockRepository.save.mockResolvedValue(mockNotification);

      await service.create(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
        NotificationType.EventCreated,
        'T',
        'M',
        data,
      );

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ data }),
      );
    });
  });

  describe('findAllForUser', () => {
    it('should return paginated notifications for a user', async () => {
      mockRepository.findAndCount.mockResolvedValue([[mockNotification], 1]);
      mockRepository.count.mockResolvedValue(0);

      const result = await service.findAllForUser(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
        1,
        20,
      );

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.unreadCount).toBe(0);
    });

    it('should query read filter when provided', async () => {
      mockRepository.findAndCount.mockResolvedValue([[], 0]);
      mockRepository.count.mockResolvedValue(0);

      await service.findAllForUser(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
        1,
        20,
        false,
      );

      expect(mockRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            user_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
            read: false,
          },
        }),
      );
    });

    it('should cap limit at 100', async () => {
      mockRepository.findAndCount.mockResolvedValue([[], 0]);
      mockRepository.count.mockResolvedValue(0);

      const result = await service.findAllForUser(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
        1,
        999,
      );

      expect(result.limit).toBe(100);
      expect(mockRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('markAsRead', () => {
    it('should update notification read to true and broadcast when owner matches', async () => {
      mockRepository.update.mockResolvedValue({ affected: 1 });

      await service.markAsRead(1, 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN');

      expect(mockRepository.update).toHaveBeenCalledWith(
        { id: 1, user_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN' },
        { read: true },
      );
      expect(
        mockNotificationBroadcaster.broadcastNotificationRead,
      ).toHaveBeenCalledWith('GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN', 1);
    });

    it('should throw NotFoundException when notification belongs to a different user', async () => {
      mockRepository.update.mockResolvedValue({ affected: 0 });

      await expect(service.markAsRead(1, 'GDIFFERENTADDRESS')).rejects.toThrow(
        NotFoundException,
      );

      expect(
        mockNotificationBroadcaster.broadcastNotificationRead,
      ).not.toHaveBeenCalled();
    });
  });

  describe('markAllAsRead', () => {
    it('should mark all unread notifications as read', async () => {
      mockRepository.update.mockResolvedValue({ affected: 3 });

      const result = await service.markAllAsRead(
        'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
      );

      expect(mockRepository.update).toHaveBeenCalledWith(
        {
          user_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
          read: false,
        },
        { read: true },
      );
      expect(result).toEqual({ updated: 3 });
    });
  });

  describe('remove', () => {
    it('should soft delete notification when found and owned by user', async () => {
      mockRepository.findOne.mockResolvedValue(mockNotification);
      mockRepository.softDelete.mockResolvedValue({ affected: 1 });

      await service.remove(1, 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN');

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: {
          id: 1,
          user_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN',
        },
      });
      expect(mockRepository.softDelete).toHaveBeenCalledWith(1);
    });

    it('should throw NotFoundException when notification not found or not owned', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(
        service.remove(1, 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNRBF7XN'),
      ).rejects.toThrow(NotFoundException);

      expect(mockRepository.softDelete).not.toHaveBeenCalled();
    });
  });
});
