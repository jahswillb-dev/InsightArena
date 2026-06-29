import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AchievementsService } from './achievements.service';
import { Achievement, AchievementType } from './entities/achievement.entity';
import { UserAchievement } from './entities/user-achievement.entity';
import { User } from '../users/entities/user.entity';

describe('AchievementsService', () => {
  let service: AchievementsService;
  let achievementsRepository: jest.Mocked<Repository<Achievement>>;
  let userAchievementsRepository: jest.Mocked<Repository<UserAchievement>>;
  let usersRepository: jest.Mocked<Repository<User>>;

  const mockUser = {
    id: 'user-1',
    stellar_address: 'GABC123',
    total_predictions: 10,
    correct_predictions: 9,
    total_staked_stroops: '5000000',
    reputation_score: 600,
  } as User;

  beforeEach(async () => {
    achievementsRepository = {
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
    } as any;

    userAchievementsRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    } as any;

    usersRepository = {
      findOne: jest.fn().mockResolvedValue(mockUser),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AchievementsService,
        {
          provide: getRepositoryToken(Achievement),
          useValue: achievementsRepository,
        },
        {
          provide: getRepositoryToken(UserAchievement),
          useValue: userAchievementsRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: usersRepository,
        },
      ],
    }).compile();

    service = module.get<AchievementsService>(AchievementsService);
  });

  it('should initialize achievements on first call', async () => {
    await service.initializeAchievements();
    expect(achievementsRepository.save).toHaveBeenCalled();
  });

  it('should check and unlock achievements for user', async () => {
    const mockAchievement = {
      id: 'ach-1',
      type: AchievementType.FIRST_PREDICTION,
      title: 'First Step',
    } as Achievement;

    achievementsRepository.findOne.mockResolvedValue(mockAchievement);
    userAchievementsRepository.findOne.mockResolvedValue(null);

    await service.checkAndUnlockAchievements(mockUser);

    expect(userAchievementsRepository.save).toHaveBeenCalled();
  });

  it('should get user achievements', async () => {
    const mockAchievements = [
      {
        id: 'ach-1',
        type: AchievementType.FIRST_PREDICTION,
        title: 'First Step',
        description: 'Make your first prediction',
        icon_url: null,
        reward_points: 10,
      },
    ] as Achievement[];

    const mockUserAchievements = [
      {
        achievement: mockAchievements[0],
        is_unlocked: true,
        unlocked_at: new Date(),
      },
    ] as UserAchievement[];

    usersRepository.findOne.mockResolvedValue(mockUser);
    userAchievementsRepository.find.mockResolvedValue(mockUserAchievements);
    achievementsRepository.find.mockResolvedValue(mockAchievements);

    const result = await service.getUserAchievements(mockUser.stellar_address);

    expect(result).toHaveLength(1);
    expect(result[0].is_unlocked).toBe(true);
  });

  describe('accuracy achievement boundary tests', () => {
    const makeUser = (correct: number, total: number) =>
      ({
        id: 'user-1',
        stellar_address: 'GABC123',
        total_predictions: total,
        correct_predictions: correct,
        total_staked_stroops: '0',
        reputation_score: 0,
      }) as User;

    beforeEach(() => {
      achievementsRepository.findOne.mockImplementation((options: any) => {
        const type = options?.where?.type;
        return Promise.resolve({ id: `ach-${type}`, type } as Achievement);
      });
      userAchievementsRepository.findOne.mockResolvedValue(null);
      userAchievementsRepository.save.mockClear();
    });

    const savedTypes = () =>
      userAchievementsRepository.save.mock.calls.map(
        (call) => (call[0] as any).achievement.type,
      );

    it('should NOT unlock ACCURACY_75 at 74% accuracy (below boundary)', async () => {
      usersRepository.findOne.mockResolvedValue(makeUser(74, 100));
      await service.checkAndUnlockAchievements(makeUser(74, 100));
      expect(savedTypes()).not.toContain(AchievementType.ACCURACY_75);
    });

    it('should unlock ACCURACY_75 at exactly 75% accuracy', async () => {
      usersRepository.findOne.mockResolvedValue(makeUser(75, 100));
      await service.checkAndUnlockAchievements(makeUser(75, 100));
      expect(savedTypes()).toContain(AchievementType.ACCURACY_75);
    });

    it('should NOT unlock ACCURACY_90 at 89% accuracy (below boundary)', async () => {
      usersRepository.findOne.mockResolvedValue(makeUser(89, 100));
      await service.checkAndUnlockAchievements(makeUser(89, 100));
      expect(savedTypes()).not.toContain(AchievementType.ACCURACY_90);
    });

    it('should unlock ACCURACY_90 at exactly 90% accuracy', async () => {
      usersRepository.findOne.mockResolvedValue(makeUser(90, 100));
      await service.checkAndUnlockAchievements(makeUser(90, 100));
      expect(savedTypes()).toContain(AchievementType.ACCURACY_90);
    });

    it('should NOT unlock any accuracy achievement when total_predictions is 0', async () => {
      usersRepository.findOne.mockResolvedValue(makeUser(0, 0));
      await service.checkAndUnlockAchievements(makeUser(0, 0));
      expect(savedTypes()).not.toContain(AchievementType.ACCURACY_75);
      expect(savedTypes()).not.toContain(AchievementType.ACCURACY_90);
    });
  });

  describe('idempotency: no double-award', () => {
    const qualifyingUser = {
      id: 'user-1',
      stellar_address: 'GABC123',
      total_predictions: 1,
      correct_predictions: 0,
      total_staked_stroops: '0',
      reputation_score: 0,
    } as User;

    const firstPredictionAchievement = {
      id: 'ach-first-prediction',
      type: AchievementType.FIRST_PREDICTION,
      title: 'First Step',
    } as Achievement;

    const existingUserAchievement = {
      id: 'ua-1',
      user: qualifyingUser,
      achievement: firstPredictionAchievement,
      is_unlocked: true,
      unlocked_at: new Date(),
    } as UserAchievement;

    beforeEach(() => {
      usersRepository.findOne.mockResolvedValue(qualifyingUser);
      achievementsRepository.findOne.mockResolvedValue(
        firstPredictionAchievement,
      );
      // First invocation: no existing record yet → save triggers
      userAchievementsRepository.findOne.mockResolvedValueOnce(null);
      // Second invocation: record already exists → save is skipped
      userAchievementsRepository.findOne.mockResolvedValue(
        existingUserAchievement,
      );
    });

    it('should save FIRST_PREDICTION exactly once when checkAndUnlockAchievements is called twice', async () => {
      await service.checkAndUnlockAchievements(qualifyingUser);
      await service.checkAndUnlockAchievements(qualifyingUser);

      expect(userAchievementsRepository.save).toHaveBeenCalledTimes(1);
    });

    it('should call findOne on every invocation to guard against duplicate rows', async () => {
      await service.checkAndUnlockAchievements(qualifyingUser);
      await service.checkAndUnlockAchievements(qualifyingUser);

      // findOne is invoked once per call (proves the guard runs each time, not just the first)
      expect(userAchievementsRepository.findOne).toHaveBeenCalledTimes(2);
      // save only fires on the first call when findOne returned null
      expect(userAchievementsRepository.save).toHaveBeenCalledTimes(1);
    });
  });
});
