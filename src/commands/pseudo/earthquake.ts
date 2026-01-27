import { In } from 'typeorm';
import { normalizeText } from '@utils/string';
import { BotClient } from '@services/client';
import { Earthquake, EarthquakeLogs } from '@src/types/database/entities/earthquake';
import { EarthquakeSubscription } from '@src/types/database/entities/earthquake_subscription';
import { Cron } from '@src/types/decorator/cronjob';
import {
    SettingChannelMenuComponent,
    SettingGenericSettingComponent,
    SettingModalComponent,
    SettingRoleSelectMenuComponent,
} from '@src/types/decorator/settingcomponents';
import { CustomizableCommand } from '@src/types/structure/command';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChannelSelectMenuInteraction,
    ChannelType,
    Colors,
    EmbedBuilder,
    ModalSubmitInteraction,
    RoleSelectMenuBuilder,
    RoleSelectMenuInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';

/**
 * A pseudo-command that notifies a channel about recent earthquakes.
 *
 * This command uses a cron job to periodically fetch earthquake data from the Seismic Portal API.
 * It filters earthquakes based on a configurable magnitude limit and sends a detailed notification
 * to a designated channel for each new earthquake that meets the criteria.
 * The location of the earthquake is reverse-geocoded to provide a human-readable locality.
 *
 * The command is highly configurable through the settings UI, allowing administrators to:
 * - Enable or disable the notifier.
 * - Set the notification channel.
 * - Define the minimum magnitude for an earthquake to be reported.
 * - Set the specific Seismic Portal API URL.
 * - Specify a region code for reverse-geocoding.
 */
export default class EarthquakeNotifierCommand extends CustomizableCommand {
    // ============================ HEADER ============================ //
    constructor() {
        super({ name: 'earthquake' });
        this.base_cmd_data = null;
    }

    public async prepareCommandData(guild_id: bigint): Promise<void> {
        this.log('debug', 'prepare.start', { name: this.name, guild: guild_id });
        const guild = await this.db.getGuild(guild_id);
        const system_user = await this.db.getUser(BigInt(0));
        let earthquake = await this.db.findOne(Earthquake, { where: { from_guild: guild! } });
        if (!earthquake) {
            const new_settings = new Earthquake();
            new_settings.is_enabled = false;
            new_settings.latest_action_from_user = system_user!;
            new_settings.from_guild = guild!;
            earthquake = await this.db.save(new_settings);
            this.log('log', 'prepare.database.success', { name: this.name, guild: guild_id });
        }
        this.enabled = earthquake.is_enabled;
        this.log('debug', 'prepare.success', { name: this.name, guild: guild_id });
    }
    // ================================================================ //

    // =========================== EXECUTE ============================ //
    /**
     * Executes the earthquake notification cron job.
     * This method runs every 5 minutes as defined by the `@Cron` decorator.
     * It fetches data for all enabled guilds, checks for new earthquakes exceeding the magnitude limit,
     * reverse-geocodes the location, and sends a notification embed to the configured channel.
     * It also manages a log of delivered earthquakes to avoid duplicate notifications and prunes old logs.
     */
    @Cron({ schedule: '*/5 * * * *' })
    public async execute(): Promise<void> {
        this.log('debug', 'cronjob.start');
        const earthquake = await this.db.find(Earthquake, { where: { is_enabled: true } });
        if (!earthquake || !earthquake.length) {
            this.log('debug', 'configuration.missing');
            return;
        }

        let delivered_count = 0;
        for (const guild of earthquake) {
            if (!guild.channel_id || !guild.seismicportal_api_url) continue;
            const earthquakes = await this.db.find(EarthquakeLogs, { where: { from_guild: guild.from_guild } });
            const request = (await (await fetch(guild.seismicportal_api_url)).json()) as {
                features: {
                    id: string;
                    properties: { time: Date; mag: number; lat: number; lon: number; auth: string };
                }[];
            };

            let recent_earthquakes = request.features
                .filter((eq) => eq.properties.mag >= guild.magnitude_limit)
                .slice(0, 25);
            if (recent_earthquakes.length === 0) continue;
            if (earthquakes.length) {
                recent_earthquakes = recent_earthquakes.filter((eq) => !earthquakes.find((e) => e.source_id === eq.id));
            }

            for (const eq of recent_earthquakes.slice(0, 25)) {
                const existing_log = await this.db.findOne(EarthquakeLogs, {
                    where: { source_id: eq.id, from_guild: guild.from_guild },
                });
                if (existing_log?.is_delivered) continue;

                const geo_response = (await (
                    await fetch(
                        `https://us1.api-bdc.net/data/reverse-geocode-client?latitude=${eq.properties.lat}&longitude=${eq.properties.lon}&localityLanguage=${guild.region_code}`,
                    )
                ).json()) as { locality?: string; city?: string; principalSubdivision?: string };

                const geo_translate = geo_response.locality || geo_response.city || geo_response.principalSubdivision;

                const locations = [geo_response.locality, geo_response.city, geo_response.principalSubdivision]
                    .filter((loc): loc is string => !!loc)
                    .map((loc) => normalizeText(loc));

                const subscribedUserIds: bigint[] = [];
                if (locations.length > 0) {
                    const subscriptions = await this.db.find(EarthquakeSubscription, {
                        where: {
                            guild: { gid: guild.from_guild.gid },
                            city: In(locations),
                        },
                    });

                    if (subscriptions.length > 0) {
                        subscribedUserIds.push(...new Set(subscriptions.map((sub) => sub.user.uid)));
                    }
                }

                let content = '';
                if (guild.ping_role_id) {
                    content = `<@&${guild.ping_role_id}>`;
                }

                if (guild.everyone_ping_threshold !== null && eq.properties.mag >= guild.everyone_ping_threshold) {
                    content = (content ? content + ' ' : '') + '@everyone';
                }

                const post = new EmbedBuilder();
                post.setTitle(
                    `:warning: ${this.t.commands({ key: 'execute.title', guild_id: BigInt(guild.from_guild.gid) })}`,
                );
                post.setColor(Colors.Yellow);
                post.setTimestamp();
                post.addFields(
                    {
                        name: this.t.commands({ key: 'execute.time', guild_id: BigInt(guild.from_guild.gid) }),
                        value: new Date(eq.properties.time).toLocaleString(),
                        inline: true,
                    },
                    {
                        name: this.t.commands({ key: 'execute.id', guild_id: BigInt(guild.from_guild.gid) }),
                        value: eq.id,
                        inline: true,
                    },
                    {
                        name: this.t.commands({ key: 'execute.location', guild_id: BigInt(guild.from_guild.gid) }),
                        value: geo_translate || 'Unknown',
                        inline: true,
                    },
                    {
                        name: this.t.commands({ key: 'execute.source', guild_id: BigInt(guild.from_guild.gid) }),
                        value: eq.properties.auth,
                        inline: true,
                    },
                    {
                        name: this.t.commands({ key: 'execute.magnitude', guild_id: BigInt(guild.from_guild.gid) }),
                        value: eq.properties.mag.toString(),
                        inline: true,
                    },
                    {
                        name: this.t.commands({ key: 'execute.coordinates', guild_id: BigInt(guild.from_guild.gid) }),
                        value: `Lat: ${eq.properties.lat}\nLon: ${eq.properties.lon}`,
                        inline: true,
                    },
                    {
                        name: this.t.commands({ key: 'execute.link', guild_id: BigInt(guild.from_guild.gid) }),
                        value: `https://www.seismicportal.eu/eventdetails.html?unid=${eq.id}`,
                    },
                    {
                        name: this.t.commands({
                            key: 'execute.other_earthquakes',
                            guild_id: BigInt(guild.from_guild.gid),
                        }),
                        value: 'https://deprem.core.xeome.dev',
                    },
                );
                const channel = await BotClient.client.guilds
                    .fetch(guild.from_guild.gid.toString())
                    .then((g) => g.channels.fetch(guild.channel_id!));
                if (channel && channel.isTextBased()) {
                    const old_logs = await this.db.find(EarthquakeLogs, {
                        where: { from_guild: guild.from_guild },
                        order: { timestamp: 'DESC' },
                    });
                    if (old_logs.length > 50) {
                        for (const old_log of old_logs.slice(50)) await this.db.remove(old_log);
                    }

                    const logs = new EarthquakeLogs();
                    logs.source_id = eq.id;
                    logs.source_name = eq.properties.auth;
                    logs.from_guild = guild.from_guild;
                    await channel
                        .send({ content: content || undefined, embeds: [post] })
                        .then(async () => {
                            logs.is_delivered = true;
                            delivered_count++;

                            // Send DMs to subscribed users
                            for (const uid of subscribedUserIds) {
                                try {
                                    const user = await BotClient.client.users.fetch(uid.toString());
                                    if (user) {
                                        await user.send({ embeds: [post] });
                                    }
                                } catch (error) {
                                    this.log('debug', 'cronjob.dm.failed', {
                                        user: uid,
                                        error: (error as Error).message,
                                    });
                                }
                            }
                        })
                        .catch(() => {
                            logs.is_delivered = false;
                        });
                    await this.db.save(logs);
                }
            }
        }
        this.log('debug', 'cronjob.success', { guild: earthquake.length, count: delivered_count });
    }
    // ================================================================ //

    // =========================== SETTINGS =========================== //
    /**
     * Toggles the earthquake notifier on or off for the guild.
     * @param interaction The interaction from the settings select menu.
     */
    @SettingGenericSettingComponent({
        database: Earthquake,
        database_key: 'is_enabled',
        format_specifier: '%s',
    })
    public async toggle(interaction: StringSelectMenuInteraction): Promise<void> {
        this.log('debug', 'settings.toggle.start', { name: this.name, guild: interaction.guild });
        const earthquake = await this.db.findOne(Earthquake, {
            where: { from_guild: { gid: BigInt(interaction.guildId!) } },
        });
        const user = (await this.db.getUser(BigInt(interaction.user.id)))!;

        earthquake!.is_enabled = !earthquake!.is_enabled;
        earthquake!.latest_action_from_user = user;
        earthquake!.timestamp = new Date();
        this.enabled = earthquake!.is_enabled;
        await this.db.save(Earthquake, earthquake!);
        await this.settingsUI(interaction);
        this.log('debug', 'settings.toggle.success', {
            name: this.name,
            guild: interaction.guild,
            toggle: this.enabled,
        });
    }

    /**
     * Sets the channel where earthquake notifications will be sent.
     * @param interaction The interaction from the channel select menu.
     */
    @SettingChannelMenuComponent({
        database: Earthquake,
        database_key: 'channel_id',
        format_specifier: '<#%s>',
        options: {
            channel_types: [ChannelType.GuildText],
        },
    })
    public async setNotificationChannel(interaction: ChannelSelectMenuInteraction): Promise<void> {
        this.log('debug', 'settings.channel.start', { name: this.name, guild: interaction.guild });
        const earthquake = await this.db.findOne(Earthquake, {
            where: { from_guild: { gid: BigInt(interaction.guildId!) } },
        });
        const user = (await this.db.getUser(BigInt(interaction.user.id)))!;

        earthquake!.channel_id = interaction.values[0];
        earthquake!.latest_action_from_user = user;
        earthquake!.timestamp = new Date();
        await this.db.save(Earthquake, earthquake!);
        await this.settingsUI(interaction);
        this.log('debug', 'settings.channel.success', {
            name: this.name,
            guild: interaction.guild,
            channel: earthquake!.channel_id,
        });
    }

    /**
     * Sets the role to be pinged on every earthquake.
     * @param interaction The interaction from the role select menu or button.
     * @param args Additional arguments (e.g., 'clear').
     */
    @SettingGenericSettingComponent({
        database: Earthquake,
        database_key: 'ping_role_id',
        format_specifier: '<@&%s>',
    })
    public async setPingRole(
        interaction: StringSelectMenuInteraction | RoleSelectMenuInteraction | ButtonInteraction,
        args?: string,
    ): Promise<void> {
        this.log('debug', 'settings.role.start', { name: this.name, guild: interaction.guild });
        const earthquake = (await this.db.findOne(Earthquake, {
            where: { from_guild: { gid: BigInt(interaction.guildId!) } },
        }))!;
        const user = (await this.db.getUser(BigInt(interaction.user.id)))!;

        if (interaction.isRoleSelectMenu()) {
            earthquake.ping_role_id = interaction.values[0];
            earthquake.latest_action_from_user = user;
            earthquake.timestamp = new Date();
            await this.db.save(Earthquake, earthquake);
            await this.settingsUI(interaction);
            this.log('debug', 'settings.role.success', {
                name: this.name,
                guild: interaction.guild,
                role: earthquake.ping_role_id,
            });
            return;
        }

        if (interaction.isButton() && args === 'clear') {
            earthquake.ping_role_id = null as any; // TypeORM will handle null
            earthquake.latest_action_from_user = user;
            earthquake.timestamp = new Date();
            await this.db.save(Earthquake, earthquake);
            await this.settingsUI(interaction);
            this.log('debug', 'settings.role.clear.success', {
                name: this.name,
                guild: interaction.guild,
            });
            return;
        }

        if (interaction.isStringSelectMenu()) {
            await interaction.update({
                components: [
                    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
                        new RoleSelectMenuBuilder()
                            .setCustomId(`settings:earthquake:setpingrole`)
                            .setPlaceholder(
                                this.t.commands({
                                    key: 'settings.setpingrole.placeholder',
                                    guild_id: BigInt(interaction.guildId!),
                                }),
                            )
                            .setMinValues(1)
                            .setMaxValues(1),
                    ),
                    new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`settings:earthquake:setpingrole:clear`)
                            .setLabel(
                                this.t.commands({
                                    key: 'settings.setpingrole.clear_label',
                                    guild_id: BigInt(interaction.guildId!),
                                }),
                            )
                            .setStyle(ButtonStyle.Danger),
                    ),
                ],
            });
        }
    }

    /**
     * Sets the minimum magnitude limit for reporting earthquakes.
     * @param interaction The interaction from the settings.
     * @param args Additional arguments.
     */
    @SettingGenericSettingComponent({
        database: Earthquake,
        database_key: 'magnitude_limit',
        format_specifier: '**%s**',
    })
    public async setMagnitudeLimit(
        interaction: StringSelectMenuInteraction | ButtonInteraction | ModalSubmitInteraction,
        args?: string,
    ): Promise<void> {
        this.log('debug', 'settings.selectmenu.start', { name: this.name, guild: interaction.guild });
        const earthquake = (await this.db.findOne(Earthquake, {
            where: { from_guild: { gid: BigInt(interaction.guildId!) } },
        }))!;
        const user = (await this.db.getUser(BigInt(interaction.user.id)))!;

        if (interaction.isButton() && args === 'set') {
            await interaction.showModal({
                customId: `settings:earthquake:setmagnitudelimit:submit`,
                title: this.t.commands({
                    key: 'settings.setmagnitudelimit.pretty_name',
                    guild_id: BigInt(interaction.guildId!),
                }),
                components: [
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId('magnitude')
                            .setLabel(
                                this.t.commands({
                                    key: 'settings.setmagnitudelimit.display_name',
                                    guild_id: BigInt(interaction.guildId!),
                                }),
                            )
                            .setPlaceholder('3.0')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true),
                    ),
                ],
            });
            return;
        }

        if (interaction.isModalSubmit() && args === 'submit') {
            const magnitude_str = interaction.fields.getTextInputValue('magnitude');
            const magnitude = parseFloat(magnitude_str.replace(',', '.'));

            if (isNaN(magnitude)) {
                this.warning = this.t.commands({
                    key: 'settings.setmagnitudelimit.invalid_value',
                    guild_id: BigInt(interaction.guildId!),
                });
                await this.settingsUI(interaction);
                return;
            }

            earthquake.magnitude_limit = magnitude;
            earthquake.latest_action_from_user = user;
            earthquake.timestamp = new Date();
            await this.db.save(Earthquake, earthquake);
            await this.settingsUI(interaction);
            this.log('debug', 'settings.selectmenu.success', { name: this.name, guild: interaction.guild });
            return;
        }

        if (interaction.isStringSelectMenu()) {
            await interaction.update({
                components: [
                    new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`settings:earthquake:setmagnitudelimit:set`)
                            .setLabel(
                                this.t.system({
                                    caller: 'buttons',
                                    key: 'set',
                                    guild_id: BigInt(interaction.guildId!),
                                }),
                            )
                            .setStyle(ButtonStyle.Primary),
                    ),
                ],
            });
        }
    }

    /**
     * Sets the threshold for pinging everyone.
     * @param interaction The interaction from the settings.
     * @param args Additional arguments.
     */
    @SettingGenericSettingComponent({
        database: Earthquake,
        database_key: 'everyone_ping_threshold',
        format_specifier: '**%s**',
    })
    public async setEveryonePingThreshold(
        interaction: StringSelectMenuInteraction | ButtonInteraction | ModalSubmitInteraction,
        args?: string,
    ): Promise<void> {
        this.log('debug', 'settings.threshold.start', { name: this.name, guild: interaction.guild });
        const earthquake = (await this.db.findOne(Earthquake, {
            where: { from_guild: { gid: BigInt(interaction.guildId!) } },
        }))!;
        const user = (await this.db.getUser(BigInt(interaction.user.id)))!;

        if (interaction.isButton() && args === 'clear') {
            earthquake.everyone_ping_threshold = null;
            earthquake.latest_action_from_user = user;
            earthquake.timestamp = new Date();
            await this.db.save(Earthquake, earthquake);
            await this.settingsUI(interaction);
            this.log('debug', 'settings.threshold.clear.success', { name: this.name, guild: interaction.guild });
            return;
        }

        if (interaction.isButton() && args === 'set') {
            await interaction.showModal({
                customId: `settings:earthquake:seteveryonepingthreshold:submit`,
                title: this.t.commands({
                    key: 'settings.seteveryonepingthreshold.pretty_name',
                    guild_id: BigInt(interaction.guildId!),
                }),
                components: [
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId('threshold')
                            .setLabel(
                                this.t.commands({
                                    key: 'settings.seteveryonepingthreshold.parameters.threshold.name',
                                    guild_id: BigInt(interaction.guildId!),
                                }),
                            )
                            .setPlaceholder('6.3')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true),
                    ),
                ],
            });
            return;
        }

        if (interaction.isModalSubmit() && args === 'submit') {
            const threshold_str = interaction.fields.getTextInputValue('threshold');
            const threshold = parseFloat(threshold_str.replace(',', '.'));

            if (isNaN(threshold)) {
                this.warning = this.t.commands({
                    key: 'settings.seteveryonepingthreshold.invalid_value',
                    guild_id: BigInt(interaction.guildId!),
                });
                await this.settingsUI(interaction);
                return;
            }

            earthquake.everyone_ping_threshold = threshold;
            earthquake.latest_action_from_user = user;
            earthquake.timestamp = new Date();
            await this.db.save(Earthquake, earthquake);
            await this.settingsUI(interaction);
            this.log('debug', 'settings.threshold.success', {
                name: this.name,
                guild: interaction.guild,
                threshold,
            });
            return;
        }

        if (interaction.isStringSelectMenu()) {
            await interaction.update({
                components: [
                    new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`settings:earthquake:seteveryonepingthreshold:set`)
                            .setLabel(
                                this.t.system({
                                    caller: 'buttons',
                                    key: 'set',
                                    guild_id: BigInt(interaction.guildId!),
                                }),
                            )
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId(`settings:earthquake:seteveryonepingthreshold:clear`)
                            .setLabel(
                                this.t.system({
                                    caller: 'buttons',
                                    key: 'clear',
                                    guild_id: BigInt(interaction.guildId!),
                                }),
                            )
                            .setStyle(ButtonStyle.Danger),
                    ),
                ],
            });
        }
    }

    /**
     * Sets the API URL for the Seismic Portal.
     * This method is triggered by a modal submission and validates the URL format.
     * @param interaction The interaction from the modal submission.
     */
    @SettingModalComponent({
        database: Earthquake,
        database_key: 'seismicportal_api_url',
        format_specifier: '[API URL](%s)',
        inputs: [
            {
                id: 'seismicportal_api_url',
                style: TextInputStyle.Short,
                required: true,
                max_length: 300,
            },
        ],
    })
    public async setSeismicportalApiUrl(interaction: ModalSubmitInteraction): Promise<void> {
        this.log('debug', 'settings.modalsubmit.start', { name: this.name, guild: interaction.guild });
        const earthquake = await this.db.findOne(Earthquake, {
            where: { from_guild: { gid: BigInt(interaction.guildId!) } },
        });
        const user = (await this.db.getUser(BigInt(interaction.user.id)))!;

        const api_url = interaction.fields.getTextInputValue('seismicportal_api_url');
        if (!api_url.match(/^https?:\/\/(www\.)?seismicportal\.eu\/fdsnws\/event\/1\/query.*/)) {
            this.log('debug', 'settings.invalid_url', {
                guild: interaction.guild,
                user: interaction.user,
                url: api_url,
            });
            this.warning = this.t.commands({
                key: 'settings.setseismicportalapiurl.invalid_url',
                guild_id: BigInt(interaction.guildId!),
            });
            await this.settingsUI(interaction);
            return;
        }

        earthquake!.seismicportal_api_url = api_url;
        earthquake!.latest_action_from_user = user;
        earthquake!.timestamp = new Date();
        await this.db.save(Earthquake, earthquake!);
        await this.settingsUI(interaction);
        this.log('debug', 'settings.modalsubmit.success', {
            name: this.name,
            guild: interaction.guild,
        });
    }

    /**
     * Sets the region code for reverse-geocoding.
     * This method is triggered by a modal submission.
     * @param interaction The interaction from the modal submission.
     */
    @SettingModalComponent({
        database: Earthquake,
        database_key: 'region_code',
        format_specifier: '`%s`',
        inputs: [
            {
                id: 'region_code',
                style: TextInputStyle.Short,
                required: true,
                max_length: 5,
            },
        ],
    })
    public async setRegionCode(interaction: ModalSubmitInteraction): Promise<void> {
        this.log('debug', 'settings.modalsubmit.start', { name: this.name, guild: interaction.guild });
        const earthquake = await this.db.findOne(Earthquake, {
            where: { from_guild: { gid: BigInt(interaction.guildId!) } },
        });
        const user = (await this.db.getUser(BigInt(interaction.user.id)))!;

        const region_code = interaction.fields.getTextInputValue('region_code');
        earthquake!.region_code = region_code;
        earthquake!.latest_action_from_user = user;
        earthquake!.timestamp = new Date();
        await this.db.save(Earthquake, earthquake!);
        await this.settingsUI(interaction);
        this.log('debug', 'settings.modalsubmit.success', {
            name: this.name,
            guild: interaction.guild,
        });
    }
    // ================================================================ //
}
