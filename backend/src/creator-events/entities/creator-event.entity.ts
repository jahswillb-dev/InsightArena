import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity('creator_events')
export class CreatorEvent {
  @PrimaryGeneratedColumn('uuid')
  @ApiProperty()
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  @ApiProperty()
  on_chain_event_id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  @ApiProperty()
  creator_address: string;

  @Column({ type: 'varchar', length: 200 })
  @ApiProperty()
  title: string;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional()
  description?: string;

  @Column({ type: 'boolean', default: true })
  @ApiProperty()
  is_active: boolean;

  @Column({ type: 'boolean', default: false })
  @ApiProperty()
  is_cancelled: boolean;

  @Column({ type: 'int', default: 0 })
  @ApiProperty()
  participant_count: number;

  @Column({ type: 'int', default: 0 })
  @ApiProperty()
  match_count: number;

  @Column({ type: 'boolean', default: false })
  @ApiProperty()
  winners_verified: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @ApiPropertyOptional()
  creation_fee_paid?: string;

  @Column({ type: 'timestamp', nullable: true })
  @ApiPropertyOptional()
  on_chain_created_at?: Date;

  @Column({ type: 'int', default: 0 })
  @ApiProperty()
  max_participants: number;

  @CreateDateColumn()
  @ApiProperty()
  created_at: Date;

  @UpdateDateColumn()
  @ApiProperty()
  updated_at: Date;
}
