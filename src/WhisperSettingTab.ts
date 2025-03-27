import { App, PluginSettingTab, Setting } from 'obsidian';
import type WhisperPlugin from './main';

export class WhisperSettingTab extends PluginSettingTab {
    plugin: WhisperPlugin;

    constructor(app: App, plugin: WhisperPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('whisper-settings');
        containerEl.createEl('h2', { text: 'Whisper プラグイン設定' });

        new Setting(containerEl)
            .setName('言語')
            .setDesc('文字起こしに使用する言語')
            .addText(text => text
                .setPlaceholder('ja')
                .setValue(this.plugin.settings.language)
                .onChange(async (value) => {
                    this.plugin.settings.language = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('モデルサイズ')
            .setDesc('使用するWhisperモデルのサイズ')
            .addDropdown(dropdown => dropdown
                .addOption('tiny', 'Tiny')
                .addOption('base', 'Base')
                .addOption('small', 'Small')
                .addOption('medium', 'Medium')
                .addOption('large', 'Large')
                .setValue(this.plugin.settings.modelSize)
                .onChange(async (value) => {
                    this.plugin.settings.modelSize = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('音声保存ディレクトリ')
            .setDesc('録音した音声ファイルを保存するディレクトリ')
            .addText(text => text
                .setPlaceholder('04_assets/audio')
                .setValue(this.plugin.settings.audioDir)
                .onChange(async (value) => {
                    this.plugin.settings.audioDir = value;
                    await this.plugin.saveSettings();
                }));
    }
}
