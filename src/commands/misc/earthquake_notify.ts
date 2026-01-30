import { EarthquakeSubscription } from '@src/types/database/entities/earthquake_subscription';
import { BaseCommand } from '@src/types/structure/command';
import { normalizeText } from '@utils/string';
import {
    ChatInputCommandInteraction,
    Colors,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
    User,
} from 'discord.js';
import pkg from '../../../package.json';

export default class EarthquakeNotifyCommand extends BaseCommand {
    constructor() {
        super({ name: 'earthquake_notify', pretty_name: 'earthquake_notify.pretty_name' });

        const builder = this.base_cmd_data as SlashCommandBuilder;
        builder
            .addSubcommand((subcommand) =>
                subcommand
                    .setName('add')
                    .setDescriptionLocalizations(this.getLocalizations('parameters.subcommand.options.add'))
                    .setDescription('Add Subscription')
                    .addStringOption((option) =>
                        option
                            .setName('city')
                            .setNameLocalizations(this.getLocalizations('parameters.city.name'))
                            .setDescriptionLocalizations(this.getLocalizations('parameters.city.description'))
                            .setDescription('The name of the city to subscribe to.')
                            .setRequired(true),
                    )
                    .addUserOption((option) =>
                        option
                            .setName('user')
                            .setNameLocalizations(this.getLocalizations('parameters.user.name'))
                            .setDescriptionLocalizations(this.getLocalizations('parameters.user.description'))
                            .setDescription('The user to manage subscriptions for (Admin only).')
                            .setRequired(false),
                    ),
            )
            .addSubcommand((subcommand) =>
                subcommand
                    .setName('remove')
                    .setDescriptionLocalizations(this.getLocalizations('parameters.subcommand.options.remove'))
                    .setDescription('Remove Subscription')
                    .addStringOption((option) =>
                        option
                            .setName('city')
                            .setNameLocalizations(this.getLocalizations('parameters.city.name'))
                            .setDescriptionLocalizations(this.getLocalizations('parameters.city.description'))
                            .setDescription('The name of the city to unsubscribe from.')
                            .setRequired(true),
                    )
                    .addUserOption((option) =>
                        option
                            .setName('user')
                            .setNameLocalizations(this.getLocalizations('parameters.user.name'))
                            .setDescriptionLocalizations(this.getLocalizations('parameters.user.description'))
                            .setDescription('The user to manage subscriptions for (Admin only).')
                            .setRequired(false),
                    ),
            )
            .addSubcommand((subcommand) =>
                subcommand
                    .setName('list')
                    .setDescriptionLocalizations(this.getLocalizations('parameters.subcommand.options.list'))
                    .setDescription('List Subscriptions')
                    .addUserOption((option) =>
                        option
                            .setName('user')
                            .setNameLocalizations(this.getLocalizations('parameters.user.name'))
                            .setDescriptionLocalizations(this.getLocalizations('parameters.user.description'))
                            .setDescription('The user to list subscriptions for (Admin only).')
                            .setRequired(false),
                    ),
            );
    }

    public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const subcommand = interaction.options.getSubcommand();
        const target_user = interaction.options.getUser('user') || interaction.user;
        const city_raw = interaction.options.getString('city');
        const city = city_raw ? normalizeText(city_raw) : null;

        // Permission check if managing another user
        if (target_user.id !== interaction.user.id) {
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: this.t.commands({
                        key: 'execute.admin_only',
                        guild_id: BigInt(interaction.guildId!),
                    }),
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
        }

        const guild = await this.db.getGuild(BigInt(interaction.guildId!));
        // Ensure user exists in DB
        let user_entity = await this.db.getUser(BigInt(target_user.id));
        if (!user_entity) {
            const Users = (await import('@src/types/database/entities/users')).Users;
            const newUser = new Users();
            newUser.uid = BigInt(target_user.id);
            newUser.name = target_user.username;
            user_entity = await this.db.save(newUser);
        }

        if (subcommand === 'add') {
            if (!city || !city_raw) return;

            // Validate city with Nominatim
            try {
                const response = await fetch(
                    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city_raw)}&format=json&limit=5`,
                    {
                        headers: {
                            'User-Agent': `${pkg.name}/${pkg.version} (https://github.com/LibreTurks/usmanagabot)`,
                        },
                    },
                );
                const data = (await response.json()) as { addresstype: string }[];
                const isValidCity = data.some((item) => item.addresstype === 'city');

                if (!isValidCity) {
                    await interaction.reply({
                        content: this.t.commands({
                            key: 'execute.city_not_found',
                            replacements: { city: city_raw },
                            guild_id: BigInt(interaction.guildId!),
                        }),
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }
            } catch (error) {
                this.log('error', 'execute.api_error', { error: (error as Error).message });
                await interaction.reply({
                    content: this.t.commands({
                        key: 'execute.api_error',
                        guild_id: BigInt(interaction.guildId!),
                    }),
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const existing = await this.db.findOne(EarthquakeSubscription, {
                where: {
                    user: { uid: BigInt(target_user.id) },
                    guild: { gid: BigInt(interaction.guildId!) },
                    city: city,
                },
            });

            if (existing) {
                await interaction.reply({
                    content: this.t.commands({
                        key: 'execute.already_exists',
                        replacements: { city: city },
                        guild_id: BigInt(interaction.guildId!),
                    }),
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const subscription = new EarthquakeSubscription();
            subscription.user = user_entity!;
            subscription.guild = guild!;
            subscription.city = city;

            await this.db.save(subscription);

            await interaction.reply({
                content: this.t.commands({
                    key: 'execute.added',
                    replacements: { city: city },
                    guild_id: BigInt(interaction.guildId!),
                }),
                flags: MessageFlags.Ephemeral,
            });
        } else if (subcommand === 'remove') {
            if (!city) return;

            const subscription = await this.db.findOne(EarthquakeSubscription, {
                where: {
                    user: { uid: BigInt(target_user.id) },
                    guild: { gid: BigInt(interaction.guildId!) },
                    city: city,
                },
            });

            if (!subscription) {
                await interaction.reply({
                    content: this.t.commands({
                        key: 'execute.not_found',
                        replacements: { city: city },
                        guild_id: BigInt(interaction.guildId!),
                    }),
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await this.db.remove(subscription);

            await interaction.reply({
                content: this.t.commands({
                    key: 'execute.removed',
                    replacements: { city: city },
                    guild_id: BigInt(interaction.guildId!),
                }),
                flags: MessageFlags.Ephemeral,
            });
        } else if (subcommand === 'list') {
            const subscriptions = await this.db.find(EarthquakeSubscription, {
                where: {
                    user: { uid: BigInt(target_user.id) },
                    guild: { gid: BigInt(interaction.guildId!) },
                },
            });

            if (subscriptions.length === 0) {
                await interaction.reply({
                    content: this.t.commands({
                        key: 'execute.no_subscriptions',
                        guild_id: BigInt(interaction.guildId!),
                    }),
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(
                    this.t.commands({
                        key: 'execute.list_header',
                        replacements: { user: target_user.username },
                        guild_id: BigInt(interaction.guildId!),
                    }),
                )
                .setColor(Colors.Blurple)
                .setDescription(subscriptions.map((sub) => `• ${sub.city}`).join('\n'));

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    }
}
