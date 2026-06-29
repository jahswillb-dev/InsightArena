import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LessThan, Repository } from 'typeorm';
import { IdempotencyKey } from './idempotency-key.entity';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;

export type AcquireResult =
  | { acquired: true; record: IdempotencyKey }
  | { acquired: false; record: IdempotencyKey };

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly repository: Repository<IdempotencyKey>,
  ) {}

  /**
   * Atomically claims a key for a user. Relies on the unique (key, userId)
   * index to detect a concurrent or prior request with the same key.
   */
  async acquire(
    key: string,
    userId: string,
    requestHash: string,
  ): Promise<AcquireResult> {
    try {
      const inserted = await this.repository.save(
        this.repository.create({
          key,
          userId,
          request_hash: requestHash,
          in_progress: true,
        }),
      );
      return { acquired: true, record: inserted };
    } catch (err) {
      if ((err as { code?: string }).code !== POSTGRES_UNIQUE_VIOLATION) {
        throw err;
      }
      const existing = await this.repository.findOneBy({ key, userId });
      if (!existing) {
        throw err;
      }
      return { acquired: false, record: existing };
    }
  }

  async complete(
    id: string,
    statusCode: number,
    responseBody: unknown,
  ): Promise<void> {
    await this.repository.update(id, {
      status_code: statusCode,
      response_body: responseBody as object,
      in_progress: false,
    });
  }

  /** Frees the key so the client can safely retry after a failed handler. */
  async release(id: string): Promise<void> {
    await this.repository.delete(id);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredKeys(): Promise<void> {
    const cutoff = new Date(Date.now() - CLEANUP_AGE_MS);
    const { affected } = await this.repository.delete({
      created_at: LessThan(cutoff),
    });
    if (affected) {
      this.logger.log(`Cleaned up ${affected} expired idempotency key(s)`);
    }
  }
}
