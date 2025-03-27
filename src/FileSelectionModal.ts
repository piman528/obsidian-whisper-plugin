import { App, Modal, TFile } from 'obsidian';

export class FileSelectionModal extends Modal {
    private callback: (filePath: string | null) => void;
    private selectedFilePath: string | null = null;

    constructor(app: App, callback: (filePath: string | null) => void) {
        super(app);
        this.callback = callback;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('whisper-file-selection-modal');

        // タイトル
        contentEl.createEl('h2', { text: '文字起こしするファイルを選択' });

        // 説明
        contentEl.createEl('p', { text: '対応形式: mp3, wav, m4a, webm' });

        // ファイル選択セクション
        const fileSelectionContainer = contentEl.createDiv({ cls: 'whisper-file-selection-container' });

        // ファイル一覧を表示
        this.displayAudioFiles(fileSelectionContainer);

        // ボタンコンテナ
        const buttonContainer = contentEl.createDiv({ cls: 'whisper-button-container' });

        // キャンセルボタン
        const cancelButton = buttonContainer.createEl('button', { text: 'キャンセル' });
        cancelButton.addEventListener('click', () => {
            this.close();
            this.callback(null);
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    private displayAudioFiles(container: HTMLElement) {
        // ファイル一覧をクリア
        container.empty();

        // ファイル一覧を作成
        const fileList = container.createEl('div', { cls: 'whisper-file-list' });

        // 対応する拡張子
        const supportedExtensions = ['.mp3', '.wav', '.m4a', '.webm'];

        // ボールトのファイルを取得
        const files = this.app.vault.getFiles();

        // 音声ファイルをフィルタリング
        const audioFiles = files.filter(file =>
            supportedExtensions.some(ext => file.extension.toLowerCase() === ext.substring(1))
        );

        if (audioFiles.length === 0) {
            fileList.createEl('p', { text: '対応する音声ファイルが見つかりません。' });
            return;
        }

        // ファイルをパスでソート
        audioFiles.sort((a, b) => a.path.localeCompare(b.path));

        // ファイル一覧を表示
        for (const file of audioFiles) {
            const fileItem = fileList.createEl('div', { cls: 'whisper-file-item' });

            // ファイル名とパスを表示
            fileItem.createEl('span', { text: file.name, cls: 'whisper-file-name' });
            fileItem.createEl('span', { text: file.parent?.path || '', cls: 'whisper-file-path' });

            // クリックイベント
            fileItem.addEventListener('click', () => {
                // 選択状態を更新
                const selectedItems = fileList.querySelectorAll('.selected');
                selectedItems.forEach(item => item.removeClass('selected'));
                fileItem.addClass('selected');

                // ファイルパスを保存
                this.selectedFilePath = file.path;

                // 選択ボタンを有効化
                if (this.selectedFilePath) {
                    selectButton.removeAttribute('disabled');
                }
            });
        }

        // 選択ボタン
        const selectButton = container.createEl('button', {
            text: '選択',
            cls: 'whisper-select-button',
            attr: { disabled: 'disabled' }
        });

        selectButton.addEventListener('click', () => {
            if (this.selectedFilePath) {
                this.close();
                this.callback(this.selectedFilePath);
            }
        });
    }
}
