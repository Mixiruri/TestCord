/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { TestcordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { MediaEngineStore } from "@webpack/common";

const logger = new Logger("CustomMicQuality");

const QUALITY_OPTIONS = [
    { label: "Absolute Trash (1kbps, 8kHz)", value: "absolute_trash", bitrate: 1000, rate: 8000 },
    { label: "Garbage (4kbps, 8kHz)", value: "garbage", bitrate: 4000, rate: 8000 },
    { label: "Popcorn (8kbps, 8kHz)", value: "popcorn", bitrate: 8000, rate: 8000 },
    { label: "Low (32kbps, 24kHz)", value: "low", bitrate: 32000, rate: 24000 },
    { label: "Standard (64kbps, 48kHz)", value: "standard", bitrate: 64000, rate: 48000 },
    { label: "High (128kbps, 48kHz)", value: "high", bitrate: 128000, rate: 48000 },
    { label: "Studio (512kbps, 48kHz)", value: "studio", bitrate: 512000, rate: 48000 },
];

const EFFECTS_OPTIONS = [
    { label: "None", value: "none" },
    { label: "Robot / 8-bit", value: "robot" },
];

const settings = definePluginSettings({
    qualityEnabled: {
        type: OptionType.BOOLEAN,
        description: "Override microphone quality/bitrate.",
        default: true,
        restartNeeded: false,
        onChange: triggerLiveUpdate,
    },
    quality: {
        type: OptionType.SELECT,
        description: "Microphone Quality Preset",
        options: QUALITY_OPTIONS.map(q => ({ label: q.label, value: q.value, default: q.value === "standard" })),
        onChange: triggerLiveUpdate,
    },
    stereo: {
        type: OptionType.BOOLEAN,
        description: "Enable Stereo Audio (requires restart to fully apply). Noise cancellation should be off.",
        default: false,
        restartNeeded: true,
    },
    echoCancellation: {
        type: OptionType.BOOLEAN,
        description: "Enable Echo Cancellation",
        default: true,
        restartNeeded: false,
        onChange: triggerLiveUpdate,
    },
    noiseSuppression: {
        type: OptionType.BOOLEAN,
        description: "Enable Noise Suppression",
        default: true,
        restartNeeded: false,
        onChange: triggerLiveUpdate,
    },
    agc: {
        type: OptionType.BOOLEAN,
        description: "Enable Automatic Gain Control (AGC)",
        default: true,
        restartNeeded: false,
        onChange: triggerLiveUpdate,
    },
    funEffect: {
        type: OptionType.SELECT,
        description: "Fun Audio Effects",
        options: EFFECTS_OPTIONS.map(e => ({ label: e.label, value: e.value, default: e.value === "none" })),
        onChange: triggerLiveUpdate,
    }
});

function getQualityData(value: string) {
    return QUALITY_OPTIONS.find(q => q.value === value) ?? QUALITY_OPTIONS[2];
}

function patchTransportOptions(options: Record<string, any>, connection: any) {
    const s = settings.store;

    if (!options.audioEncoder) {
        try {
            options.audioEncoder = { ...connection.getCodecOptions("opus").audioEncoder };
        } catch (e) {
            options.audioEncoder = {};
        }
    }

    if (s.qualityEnabled) {
        const qualityData = getQualityData(s.quality);
        options.encodingVoiceBitRate = qualityData.bitrate;
        options.audioEncoder.rate = qualityData.rate;
    }

    if (s.stereo) {
        options.audioEncoder.channels = 2;
    } else {
        options.audioEncoder.channels = 1;
    }

    if (s.funEffect === "robot") {
        options.audioEncoder.rate = 8000;
        options.audioEncoder.pacsize = 20; // very low packet size makes it sound robotic and stuttery
        options.encodingVoiceBitRate = 8000;
    }

    options.echoCancellation = s.echoCancellation;
    options.noiseSuppression = s.noiseSuppression;
    options.automaticGainControl = s.agc;

    // Apply voice modes if available inside transport options
    if (options.modes) {
        options.modes = {
            ...options.modes,
            echoCancellation: s.echoCancellation,
            noiseSuppression: s.noiseSuppression,
            automaticGainControl: s.agc
        };
    }
}

let mediaEngine: any = null;
let connectionHandler: ((...args: any[]) => void) | null = null;
const patchedConnections = new Set<string>();
const activeConnections = new Set<any>();

function triggerLiveUpdate() {
    for (const connection of activeConnections) {
        if (connection.destroyed) {
            activeConnections.delete(connection);
            continue;
        }

        try {
            const transportOptions: Record<string, any> = {};
            const baseAudioEncoder = connection.getCodecOptions("opus")?.audioEncoder || {};
            transportOptions.audioEncoder = { ...baseAudioEncoder };

            // Set default voice bit rate based on discord behavior before overriding
            transportOptions.encodingVoiceBitRate = 64000;

            // Re-apply the patch over an empty object
            patchTransportOptions(transportOptions, connection);

            // Calling the hooked method applies our patches to the connection.conn
            connection.conn.setTransportOptions(transportOptions);
            logger.info("Triggered live update for mic options on connection", connection.mediaEngineConnectionId);
        } catch (e) {
            logger.error("Failed to live update mic options", e);
        }
    }
}

function onConnection(connection: any) {
    // Both default voice and streaming connections have an audio track, but we mainly want to apply to user audio.
    // context 'default' is standard voice call.
    if (connection.context !== "default" && connection.context !== "stream") return;

    activeConnections.add(connection);

    const connId = connection.mediaEngineConnectionId;
    if (patchedConnections.has(connId)) return;
    patchedConnections.add(connId);

    logger.info("Patching audio connection", connId);

    const origSetTransportOptions = connection.conn.setTransportOptions;
    connection.conn.setTransportOptions = function (this: any, options: Record<string, any>) {
        patchTransportOptions(options, connection);
        logger.info("Overridden audio transport options", options);
        return Reflect.apply(origSetTransportOptions, this, [options]);
    };

    const emitter = connection.emitter ?? connection;

    const onConnected = () => {
        const transportOptions: Record<string, any> = {};
        try {
            transportOptions.audioEncoder = { ...connection.getCodecOptions("opus").audioEncoder };
            transportOptions.encodingVoiceBitRate = 64000;
        } catch (e) { }

        patchTransportOptions(transportOptions, connection);
        logger.info("Force updating audio transport options on connected", transportOptions);
        origSetTransportOptions(transportOptions);
    };

    const onDestroy = () => {
        patchedConnections.delete(connId);
        activeConnections.delete(connection);
        try {
            emitter.removeListener("connected", onConnected);
            emitter.removeListener("destroy", onDestroy);
        } catch { }
    };

    try {
        emitter.on("connected", onConnected);
        emitter.on("destroy", onDestroy);
    } catch (e) {
        logger.error("Failed to attach connection event listeners", e);
    }
}

export default definePlugin({
    name: "CustomMicQuality",
    description: "Customize your microphone quality, bitrates, stereo mode, echo cancellation, and apply fun effects.",
    authors: [TestcordDevs.x2b],
    settings,
    patches: [
        // Also inject physical stereo codec change like StereoMic does to ensure WebRTC accepts stereo channel mapping.
        {
            find: "Audio codecs",
            replacement: {
                match: /channels:1,/,
                replace: "channels:2,prams:{stereo:\"2\"},",
                predicate: () => settings.store.stereo
            }
        }
    ],
    start() {
        try {
            mediaEngine = MediaEngineStore.getMediaEngine();
            if (!mediaEngine) {
                logger.error("Could not get media engine");
                return;
            }

            const emitter = mediaEngine.emitter ?? mediaEngine;

            connectionHandler = (connection: any) => {
                try {
                    onConnection(connection);
                } catch (e) {
                    logger.error("Error in connection handler", e);
                }
            };

            emitter.on("connection", connectionHandler);
            logger.info("CustomMicQuality started");
        } catch (e) {
            logger.error("Failed to start CustomMicQuality", e);
        }
    },
    stop() {
        try {
            if (mediaEngine && connectionHandler) {
                const emitter = mediaEngine.emitter ?? mediaEngine;
                emitter.removeListener("connection", connectionHandler);
            }
            connectionHandler = null;
            mediaEngine = null;
            patchedConnections.clear();
            activeConnections.clear();
            logger.info("CustomMicQuality stopped");
        } catch (e) {
            logger.error("Failed to stop CustomMicQuality", e);
        }
    },
});
