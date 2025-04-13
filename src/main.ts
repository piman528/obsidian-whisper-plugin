import { App, Editor, MarkdownView, Notice, Plugin, FileSystemAdapter } from 'obsidian';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { setFfmpegPath } from 'fluent-ffmpeg';
import { WhisperPluginSettings, DEFAULT_SETTINGS } from './types';
import { WhisperSettingTab } from './WhisperSettingTab';
import { FileSelectionModal } from './FileSelectionModal';
import { AudioProcessor } from './AudioProcessor';

// ffmpegのパスを設定
setFfmpegPath('/opt/homebrew/bin/ffmpeg');

export default class WhisperPlugin extends Plugin {
    settings: WhisperPluginSettings;
    private mediaRecorder: MediaRecorder | null = null;
    private audioChunks: Blob[] = [];
    private isRecording = false;
    private isProcessing = false;
    private tempDir: string;
    private statusBarItem: HTMLElement;
    private cancelButton: HTMLElement;
    private ribbonIcon: HTMLElement;
    private audioProcessor: AudioProcessor;

    async onload() {
        await this.loadSettings();
        this.tempDir = path.join(os.tmpdir(), 'obsidian-whisper');

        // スクリプトディレクトリを確認
        const pluginDir = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
        const scriptsDir = path.join(pluginDir, 'scripts');
        if (!fs.existsSync(scriptsDir)) {
            fs.mkdirSync(scriptsDir, { recursive: true });
        }

        // 一時ディレクトリを確認
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }

        // AudioProcessorの初期化
        this.audioProcessor = new AudioProcessor(
            this.tempDir,
            (progress: string) => {
                this.statusBarItem.setText(progress);
            },
            (error: string) => {
                new Notice(error);
            }
        );

        this.ribbonIcon = this.addRibbonIcon('microphone', '録音開始', async () => {
            if (this.isRecording) {
                await this.stopRecording();
            } else {
                await this.startRecording();
            }
        });

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.hide();

        // キャンセルボタンを追加
        this.cancelButton = this.addStatusBarItem();
        this.cancelButton.addClass('whisper-cancel-button');
        this.cancelButton.setText('文字起こしをキャンセル');
        this.cancelButton.hide();
        this.cancelButton.onClickEvent(() => {
            this.cancelTranscription();
        });

        // ファイルから文字起こしするコマンドを追加
        this.addCommand({
            id: 'transcribe-file',
            name: 'ファイルから文字起こし',
            callback: async () => {
                await this.openFileSelectionModal();
            }
        });

        this.addSettingTab(new WhisperSettingTab(this.app, this));
    }

    onunload() {
        if (this.isRecording) {
            this.stopRecording();
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const options = {
                mimeType: 'audio/webm;codecs=opus',
                audioBitsPerSecond: 128000,  // 128kbps
            };

            // サポートされているMIMEタイプをチェック
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                throw new Error(`${options.mimeType}がサポートされていません`);
            }

            this.mediaRecorder = new MediaRecorder(stream, options);
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                this.audioChunks.push(event.data);
            };

            this.mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(this.audioChunks, {
                    type: 'audio/webm;codecs=opus'
                });

                // Blobが正しく生成されたか確認
                if (audioBlob.size === 0) {
                    throw new Error('録音データの生成に失敗しました');
                }

                await this.processAudio(audioBlob);
            };

            this.mediaRecorder.start(1000);
            this.isRecording = true;
            this.ribbonIcon.addClass('whisper-recording');
            this.statusBarItem.setText('録音中...');
            this.statusBarItem.show();
            new Notice('録音を開始しました');
        } catch (error) {
            console.error('録音の開始に失敗:', error);
            new Notice('録音の開始に失敗しました');
            this.showError('マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。');
        }
    }

    private async stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            this.ribbonIcon.removeClass('whisper-recording');
            this.statusBarItem.setText('文字起こし中...');
            this.isProcessing = true;
            this.cancelButton.show();
            new Notice('録音を停止しました');
        }
    }

    private cancelTranscription() {
        if (!this.isProcessing) return;

        this.audioProcessor.cancelProcessing();

        // UI状態をリセット
        this.isProcessing = false;
        this.statusBarItem.hide();
        this.cancelButton.hide();
        new Notice('文字起こしをキャンセルしました');
    }

    private async openFileSelectionModal() {
        const modal = new FileSelectionModal(this.app, async (filePath) => {
            if (filePath) {
                await this.transcribeExternalFile(filePath);
            }
        });
        modal.open();
    }

    private showError(message: string) {
        const errorDiv = document.createElement('div');
        errorDiv.addClass('whisper-error');
        errorDiv.setText(message);
        new Notice(message, 5000);
    }

    private async transcribeExternalFile(filePath: string) {
        this.statusBarItem.setText('文字起こし中...');
        this.statusBarItem.show();
        this.isProcessing = true;
        this.cancelButton.show();
        new Notice('文字起こしを開始しました');

        // Obsidianのファイルパスを実際のファイルシステムのパスに変換
        let realFilePath = filePath;
        try {
            // ボールト内のファイルの場合
            if (this.app.vault.getAbstractFileByPath(filePath)) {
                const adapter = this.app.vault.adapter as FileSystemAdapter;
                const basePath = adapter.getBasePath();
                realFilePath = path.join(basePath, filePath);
                console.log(`ファイルパス変換: ${filePath} -> ${realFilePath}`);
            }
        } catch (error) {
            console.error('ファイルパス変換エラー:', error);
        }

        try {
            const pluginDir = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
            const result = await this.audioProcessor.transcribeExternalFile(realFilePath, this.settings);

            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView) {
                const editor = activeView.editor;
                const cursor = editor.getCursor();
                editor.replaceRange(result.trim(), cursor);
                new Notice('文字起こしが完了しました');
            }
        } catch (error) {
            console.error('音声処理に失敗:', error);
            this.showError('音声処理に失敗しました');
        } finally {
            this.statusBarItem.hide();
            this.cancelButton.hide();
            this.isProcessing = false;
        }
    }

    private async processAudio(audioBlob: Blob) {
        try {
            const pluginDir = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
            const filename = `Recording ${timestamp}.mp3`;

            // 音声ファイルの処理と文字起こし
            const { transcription, mp3Buffer } = await this.audioProcessor.processAudioBlob(
                audioBlob,
                this.settings,
                pluginDir
            );

            // 音声ファイルの保存先パスを正規化
            const normalizedPath = path.join(this.settings.audioDir, filename)
                .split(path.sep)
                .join('/');

            // Obsidian Vaultに直接ファイルを保存
            await this.app.vault.createBinary(
                normalizedPath,
                mp3Buffer
            );

            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView) {
                const editor = activeView.editor;
                const cursor = editor.getCursor();
                editor.replaceRange(`\n![[${filename}]]\n${transcription}`, cursor);
                new Notice('文字起こしが完了しました');
            }
        } catch (error) {
            console.error('音声処理に失敗:', error);
            this.showError('音声処理に失敗しました');
        } finally {
            this.statusBarItem.hide();
            this.cancelButton.hide();
            this.isProcessing = false;
        }
    }
}
