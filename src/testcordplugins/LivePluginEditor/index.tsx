/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import { TestcordDevs } from "@utils/constants";
import { localStorage } from "@utils/localStorage";
import definePlugin, { OptionType } from "@utils/types";
import { React, ReactDOM } from "@webpack/common";

import { LivePluginEditor } from "./components/Editor";

const STORAGE_KEY = "testcord-live-plugins";

export interface LivePlugin {
    id: string;
    name: string;
    code: string;
    enabled: boolean;
    description?: string;
}

// Use a simpler type for the plugin instance
interface LivePluginInstance {
    name: string;
    description?: string;
    authors?: Array<{ name: string; id?: bigint; }>;
    start?: () => void;
    stop?: () => void;
    started?: boolean;
    [key: string]: unknown;
}

export const classFactory = classNameFactory("vc-live-plugin-editor-");

export const defaultPluginCode = `// Welcome to Live Plugin Editor!
// Write your plugin code here using definePlugin

definePlugin({
    name: "MyPlugin",
    description: "My awesome plugin",
    authors: [{ name: "You", id: 0n }],
    start() {
        console.log("Plugin started!");
    },
    stop() {
        console.log("Plugin stopped!");
    }
});
`;

export const settings = definePluginSettings({
    plugins: {
        type: OptionType.COMPONENT,
        component: LivePluginEditor,
        description: "Manage your live plugins",
    }
});

export function generateId(): string {
    return Math.random().toString(36).substring(2, 15);
}

export function getStoredPlugins(): LivePlugin[] {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
}

export function savePlugins(plugins: LivePlugin[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plugins));
}

export function createPlugin(name: string, code: string = defaultPluginCode): LivePlugin {
    return {
        id: generateId(),
        name,
        code,
        enabled: true,
        description: ""
    };
}

// Expose for hot-reloading
export const livePlugins: Map<string, { plugin: LivePlugin; instance: LivePluginInstance; }> = new Map();

export function loadLivePlugin(pluginData: LivePlugin): boolean {
    console.log("[LivePluginEditor] Loading plugin:", pluginData.name);

    try {
        // Stop existing instance if any
        if (livePlugins.has(pluginData.id)) {
            unloadPlugin(pluginData.id);
        }

        if (!pluginData.enabled) {
            livePlugins.delete(pluginData.id);
            return true;
        }

        // Create a sandboxed environment to evaluate the plugin code
        let capturedPlugin: LivePluginInstance | null = null;

        try {
            // Create a custom definePlugin that captures the result
            const customDefinePlugin = function (p: LivePluginInstance) {
                capturedPlugin = p;
                return p;
            };

            // Get common Vencord APIs that plugins commonly use
            const VenCord = Vencord;
            const VenCordNative = VencordNative;
            const Plugins = Vencord?.Plugins;
            const Themes = Vencord?.Themes;
            const Webpack = Vencord?.Webpack;
            const API = Vencord?.Api;

            // Get common Discord stores
            const UserStore = Vencord?.Webpack?.findByProps("getCurrentUser", "getUser");
            const ChannelStore = Vencord?.Webpack?.findByProps("getChannel", "getDMFromUserId");
            const GuildStore = Vencord?.Webpack?.findByProps("getGuild", "getGuilds");
            const MessageStore = Vencord?.Webpack?.findByProps("getMessage", "getMessages");
            const SelectedChannelStore = Vencord?.Webpack?.findByProps("getChannelId", "getLastSelectedChannelId");
            const SelectedMessageStore = Vencord?.Webpack?.findByProps("getSelectedMessageId");
            const UserProfileStore = Vencord?.Webpack?.findByProps("getUserProfile");
            const RelationshipStore = Vencord?.Webpack?.findByProps("isFriend", "getRelationship");
            const GuildMemberStore = Vencord?.Webpack?.findByProps("getMember", "getMembers");

            // Create the sandbox with common globals available in Vencord plugins
            const sandbox = new Function(
                "definePlugin",
                "Vencord",
                "VencordNative",
                "DiscordNative",
                "React",
                "ReactDOM",
                "console",
                "navigator",
                "window",
                "document",
                "localStorage",
                "fetch",
                "setTimeout",
                "setInterval",
                "clearTimeout",
                "clearInterval",
                // Vencord APIs
                "Plugins",
                "Themes",
                "Webpack",
                "API",
                // Discord Stores
                "UserStore",
                "ChannelStore",
                "GuildStore",
                "MessageStore",
                "SelectedChannelStore",
                "SelectedMessageStore",
                "UserProfileStore",
                "RelationshipStore",
                "GuildMemberStore",
                `
                ${pluginData.code}
            `);

            sandbox(
                customDefinePlugin,
                VenCord,
                VenCordNative,
                DiscordNative,
                React,
                ReactDOM,
                console,
                navigator,
                window,
                document,
                localStorage,
                fetch,
                setTimeout,
                setInterval,
                clearTimeout,
                clearInterval,
                // Vencord APIs
                Plugins,
                Themes,
                Webpack,
                API,
                // Discord Stores
                UserStore,
                ChannelStore,
                GuildStore,
                MessageStore,
                SelectedChannelStore,
                SelectedMessageStore,
                UserProfileStore,
                RelationshipStore,
                GuildMemberStore
            );

        } catch (evalError) {
            console.error("[LivePluginEditor] Error evaluating plugin code:", evalError);
            return false;
        }

        if (!capturedPlugin) {
            console.error("[LivePluginEditor] No plugin captured - definePlugin was not called");
            return false;
        }

        const pluginInstance: LivePluginInstance = capturedPlugin;

        // Ensure the plugin name matches
        pluginInstance.name = pluginData.name;

        livePlugins.set(pluginData.id, { plugin: pluginData, instance: pluginInstance });

        // Start the plugin
        try {
            if (pluginInstance.start) {
                console.log("[LivePluginEditor] Calling start() on plugin:", pluginData.name);
                pluginInstance.start();
            }
            pluginInstance.started = true;
            console.log(`[LivePluginEditor] Started plugin: ${pluginData.name}`);
        } catch (e) {
            console.error(`[LivePluginEditor] Error starting plugin ${pluginData.name}:`, e);
        }

        return true;
    } catch (e) {
        console.error("[LivePluginEditor] Failed to load plugin:", e);
        return false;
    }
}

export function unloadPlugin(pluginId: string): boolean {
    const entry = livePlugins.get(pluginId);
    if (!entry) return false;

    console.log("[LivePluginEditor] Unloading plugin:", entry.plugin.name);

    const { instance } = entry;

    // Stop the plugin
    try {
        if (instance.stop && instance.started) {
            instance.stop();
        }
        instance.started = false;
    } catch (e) {
        console.error("[LivePluginEditor] Error stopping plugin:", e);
    }

    return livePlugins.delete(pluginId);
}

export function reloadPlugin(plugin: LivePlugin): boolean {
    console.log("[LivePluginEditor] Reloading plugin:", plugin.name);
    unloadPlugin(plugin.id);
    return loadLivePlugin(plugin);
}

export default definePlugin({
    name: "LivePluginEditor",
    description: "An in-app IDE to create, test, and hot-reload simple TestCord plugins without rebuilding the entire client",
    authors: [TestcordDevs.x2b],
    settings,
    start() {
        console.log("[LivePluginEditor] Starting LivePluginEditor");
        const plugins = getStoredPlugins();
        plugins.forEach(plugin => {
            if (plugin.enabled) {
                loadLivePlugin(plugin);
            }
        });
    },
    stop() {
        livePlugins.forEach((entry, id) => {
            unloadPlugin(id);
        });
    }
});
