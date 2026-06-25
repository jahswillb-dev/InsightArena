import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { LeaderboardHistory } from './entities/leaderboard-history.entity';
import { UsersModule } from '../users/users.module';
import { SeasonsModule } from '../seasons/seasons.module';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardScheduler } from './leaderboard.scheduler';
import { LeaderboardController } from './leaderboard.controller';

@Module({
  imports: [
    CacheModule.register(),
    TypeOrmModule.forFeature([LeaderboardEntry, LeaderboardHistory]),
    UsersModule,
    SeasonsModule,
  ],
  controllers: [LeaderboardController],
  providers: [LeaderboardService, LeaderboardScheduler],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
