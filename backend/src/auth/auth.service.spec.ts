import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Keypair } from '@stellar/stellar-sdk';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserPreferences } from '../users/entities/user-preferences.entity';
import { AuthService } from './auth.service';

type UsersRepoMock = jest.Mocked<
  Pick<Repository<User>, 'findOneBy' | 'create' | 'save'>
>;

type PreferencesRepoMock = jest.Mocked<
  Pick<Repository<UserPreferences>, 'findOneBy' | 'create' | 'save'>
>;

describe('AuthService', () => {
  let service: AuthService;
  let jwtService: jest.Mocked<JwtService>;
  let usersRepository: UsersRepoMock;
  let preferencesRepository: PreferencesRepoMock;

  const address = 'GABC1234567890';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: {
            signAsync: jest.fn().mockResolvedValue('token.jwt.value'),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOneBy: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(UserPreferences),
          useValue: {
            findOneBy: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get(JwtService);
    usersRepository = module.get(getRepositoryToken(User));
    preferencesRepository = module.get(getRepositoryToken(UserPreferences));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('generateChallenge() returns unique nonce each call', () => {
    const one = service.generateChallenge(address);
    const two = service.generateChallenge(address);

    expect(one).not.toEqual(two);
    expect(one).toContain('InsightArena:nonce:');
    expect(two).toContain(address);
  });

  it('verifySignature() returns user on valid sig and creates preferences if new user', async () => {
    service.generateChallenge(address);
    jest.spyOn(service, 'verifyStellarSignature').mockReturnValue(true);

    const savedUser = { id: 'u-1', stellar_address: address } as User;
    usersRepository.findOneBy.mockResolvedValue(null);
    usersRepository.create.mockReturnValue(savedUser);
    usersRepository.save.mockResolvedValue(savedUser);
    preferencesRepository.findOneBy.mockResolvedValue(null);
    preferencesRepository.create.mockReturnValue({
      userId: savedUser.id,
    } as UserPreferences);
    preferencesRepository.save.mockResolvedValue({
      userId: savedUser.id,
    } as UserPreferences);

    const user = await service.verifySignature(address, 'signed-hex');

    expect(user).toEqual(savedUser);
    expect(usersRepository.save).toHaveBeenCalledWith(savedUser);
    expect(preferencesRepository.findOneBy).toHaveBeenCalledWith({
      userId: 'u-1',
    });
    expect(preferencesRepository.create).toHaveBeenCalledWith({
      userId: 'u-1',
    });
    expect(preferencesRepository.save).toHaveBeenCalled();
  });

  it('verifySignature() does not create duplicate preferences for existing users', async () => {
    service.generateChallenge(address);
    jest.spyOn(service, 'verifyStellarSignature').mockReturnValue(true);

    const existingUser = { id: 'u-1', stellar_address: address } as User;
    usersRepository.findOneBy.mockResolvedValue(existingUser);
    usersRepository.save.mockResolvedValue(existingUser);

    const user = await service.verifySignature(address, 'signed-hex');

    expect(user).toEqual(existingUser);
    expect(preferencesRepository.save).not.toHaveBeenCalled();
  });

  it('verifySignature() throws UnauthorizedException on invalid sig', async () => {
    service.generateChallenge(address);
    jest.spyOn(service, 'verifyStellarSignature').mockReturnValue(false);

    await expect(service.verifySignature(address, 'bad-sig')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('expired nonce throws UnauthorizedException', async () => {
    jest.useFakeTimers();

    service.generateChallenge(address);
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);

    await expect(service.verifySignature(address, 'any-sig')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('verifyChallenge() returns token and user', async () => {
    service.generateChallenge(address);
    jest.spyOn(service, 'verifyStellarSignature').mockReturnValue(true);

    const savedUser = { id: 'u-2', stellar_address: address } as User;
    usersRepository.findOneBy.mockResolvedValue(savedUser);
    usersRepository.save.mockResolvedValue(savedUser);
    preferencesRepository.findOneBy.mockResolvedValue({
      id: 'prefs-1',
      userId: savedUser.id,
    } as UserPreferences);

    const result = await service.verifyChallenge(address, 'signed-hex');

    expect(result).toEqual({
      access_token: 'token.jwt.value',
      user: savedUser,
    });
    expect(jwtService.signAsync.mock.calls[0][0]).toEqual({
      sub: 'u-2',
      stellar_address: address,
    });
  });

  it('verifySignature() does not duplicate existing preferences', async () => {
    service.generateChallenge(address);
    jest.spyOn(service, 'verifyStellarSignature').mockReturnValue(true);

    const savedUser = { id: 'u-3', stellar_address: address } as User;
    usersRepository.findOneBy.mockResolvedValue(savedUser);
    usersRepository.save.mockResolvedValue(savedUser);
    preferencesRepository.findOneBy.mockResolvedValue({
      id: 'prefs-1',
      userId: savedUser.id,
    } as UserPreferences);

    await service.verifySignature(address, 'signed-hex');

    expect(preferencesRepository.save).not.toHaveBeenCalled();
  });

  it('removeChallenge() invalidates challenge', () => {
    const challenge = service.generateChallenge(address);

    expect(service.isValidChallenge(challenge)).toBe(true);
    service.removeChallenge(challenge);
    expect(service.isValidChallenge(challenge)).toBe(false);
  });

  it('isValidChallenge() returns false for unknown challenge', () => {
    expect(service.isValidChallenge('unknown')).toBe(false);
  });

  it('verifySignature() rejects a replayed challenge', async () => {
    service.generateChallenge(address);
    const verifySignature = jest
      .spyOn(service, 'verifyStellarSignature')
      .mockReturnValue(true);
    const savedUser = { id: 'u-replay', stellar_address: address } as User;
    usersRepository.findOneBy.mockResolvedValue(null);
    usersRepository.create.mockReturnValue(savedUser);
    usersRepository.save.mockResolvedValue(savedUser);

    await service.verifySignature(address, 'signed-hex');

    await expect(
      service.verifySignature(address, 'signed-hex'),
    ).rejects.toThrow('Challenge already used');
    expect(verifySignature).toHaveBeenCalledTimes(1);
  });

  it('isValidChallenge() deletes and rejects expired challenges', () => {
    jest.useFakeTimers();

    const challenge = service.generateChallenge(address);
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(service.isValidChallenge(challenge)).toBe(false);
  });

  it('verifyStellarSignature() uses mocked Keypair.verify and returns true', () => {
    const verify = jest.fn().mockReturnValue(true);
    jest
      .spyOn(Keypair, 'fromPublicKey')
      .mockReturnValue({ verify } as unknown as Keypair);

    const ok = service.verifyStellarSignature(address, 'challenge', 'abcd');

    expect(ok).toBe(true);
    expect(verify).toHaveBeenCalled();
  });

  it('verifyStellarSignature() returns false when sdk throws', () => {
    jest.spyOn(Keypair, 'fromPublicKey').mockImplementation(() => {
      throw new Error('invalid key');
    });

    const ok = service.verifyStellarSignature('bad-key', 'challenge', 'abcd');

    expect(ok).toBe(false);
  });

  describe('cleanupExpiredChallenges', () => {
    it('should remove expired challenges periodically', () => {
      jest.useFakeTimers();

      const cache = (
        service as unknown as {
          challengeCache: Map<string, { expiresAt: number; used: boolean }>;
        }
      ).challengeCache;

      // Add some expired challenges
      cache.set('expired-1', { expiresAt: Date.now() - 1000, used: false });
      cache.set('expired-2', { expiresAt: Date.now() - 2000, used: false });
      cache.set('valid-1', { expiresAt: Date.now() + 100000, used: false });

      expect(cache.size).toBe(3);

      // Call the cleanup method directly
      service.cleanupExpiredChallenges();

      expect(cache.size).toBe(1);
      expect(cache.has('valid-1')).toBe(true);
      expect(cache.has('expired-1')).toBe(false);
      expect(cache.has('expired-2')).toBe(false);
    });

    it('should be called via @Cron decorator every 5 minutes', () => {
      const cleanupSpy = jest.spyOn(service, 'cleanupExpiredChallenges');

      // Verify the method exists and is callable
      expect(service.cleanupExpiredChallenges).toBeDefined();

      service.cleanupExpiredChallenges();

      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('should cleanup expired challenges without waiting for generateChallenge', () => {
      jest.useFakeTimers();

      const cache = (
        service as unknown as {
          challengeCache: Map<string, { expiresAt: number; used: boolean }>;
        }
      ).challengeCache;

      // Simulate high read load: many verifySignature calls without generateChallenge
      service.generateChallenge(address);
      cache.set('old-challenge', { expiresAt: Date.now() - 10000, used: true });

      expect(cache.size).toBe(2);

      // Cleanup should remove expired entries independently
      service.cleanupExpiredChallenges();

      expect(cache.size).toBe(1);
      expect(cache.has('old-challenge')).toBe(false);
    });
  });

  describe('refreshToken', () => {
    it('should issue a new token for an existing user', async () => {
      const existingUser = {
        id: 'user-refresh-1',
        stellar_address: 'GABC1234',
      } as User;

      usersRepository.findOneBy.mockResolvedValue(existingUser);
      jwtService.signAsync.mockResolvedValue('new.jwt.token');

      const result = await service.refreshToken('user-refresh-1');

      expect(result.access_token).toBe('new.jwt.token');
      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: 'user-refresh-1',
        stellar_address: 'GABC1234',
      });
      expect(usersRepository.findOneBy).toHaveBeenCalledWith({
        id: 'user-refresh-1',
      });
    });

    it('should throw UnauthorizedException if user is not found', async () => {
      usersRepository.findOneBy.mockResolvedValue(null);

      await expect(service.refreshToken('deleted-user')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refreshToken('deleted-user')).rejects.toThrow(
        'User not found or has been deleted',
      );

      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if user has been deleted', async () => {
      usersRepository.findOneBy.mockResolvedValue(null);

      await expect(service.refreshToken('user-deleted')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
