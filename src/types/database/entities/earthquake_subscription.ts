import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Guilds } from './guilds';
import { Users } from './users';

@Entity()
export class EarthquakeSubscription {
    @PrimaryGeneratedColumn({ type: 'integer' })
    id!: number;

    @ManyToOne(() => Users, { nullable: false, eager: true })
    @JoinColumn({ name: 'user', referencedColumnName: 'id' })
    user!: Users;

    @ManyToOne(() => Guilds, { nullable: false, eager: true })
    @JoinColumn({ name: 'guild', referencedColumnName: 'id' })
    guild!: Guilds;

    @Column({ type: 'text', nullable: false })
    city!: string;
}
