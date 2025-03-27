import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Notice } from 'obsidian';
import ffmpeg from 'fluent-ffmpeg';
import { FFmpegProgress } from './types';

export class AudioProcessor {
    private tempDir: string;
    private currentChildProcess: any = null;
    private currentFfmpegCommand: any = null;
    private onProgressUpdate: (progress: string) => void;
    private onError: (error: string) => void;
    private venvPath: string;
    private mlxWhisperPath: string;

    constructor(
        tempDir: string,
        onProgressUpdate: (progress: string) => void,
        onError: (error: string) => void
    ) {
        this.tempDir = tempDir;
        this.onProgressUpdate = onProgressUpdate;
        this.onError = onError;

        // whisper-envのパスを設定
        this.venvPath = path.join(process.env.HOME || '', 'Documents', 'obsidian', 'whisper-env');
        this.mlxWhisperPath = path.join(this.venvPath, 'bin', 'mlx_whisper');
    }

    public cancelProcessing() {
        // FFmpegプロセスをキャンセル
        if (this.currentFfmpegCommand) {
            try {
                this.currentFfmpegCommand.kill('SIGTERM');
                this.currentFfmpegCommand = null;
            } catch (error) {
                console.error('FFmpegプロセスのキャンセルに失敗:', error);
            }
        }

        // Whisperプロセスをキャンセル
        if (this.currentChildProcess) {
            try {
                this.currentChildProcess.kill('SIGTERM');
                this.currentChildProcess = null;
            } catch (error) {
                console.error('Whisperプロセスのキャンセルに失敗:', error);
            }
        }
    }

    public async processAudioBlob(
        audioBlob: Blob,
        settings: {
            language: string;
            modelSize: string;
            audioDir: string;
        },
        pluginDir: string
    ): Promise<{ transcription: string; mp3Buffer: Uint8Array }> {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
            const filename = `Recording ${timestamp}`;
            const tempFilePath = path.join(this.tempDir, `${filename}.webm`);

            // Stream形式でファイルに書き込む
            const buffer = Buffer.from(await audioBlob.arrayBuffer());
            await new Promise<void>((resolve, reject) => {
                const writeStream = fs.createWriteStream(tempFilePath);
                writeStream.write(buffer);
                writeStream.end();
                writeStream.on('finish', () => resolve());
                writeStream.on('error', (err) => reject(err));
            });

            // Convert to mp3 and wav
            const [tempMp3Path, wavPath] = await Promise.all([
                this.convertToMp3(tempFilePath, filename),
                this.convertToWav(tempFilePath)
            ]);

            try {
                // デバッグ情報
                console.log('Plugin Directory:', pluginDir);
                console.log('Settings Audio Directory:', settings.audioDir);

                // vaultBasePathの取得方法を修正
                const vaultBasePath = path.resolve(path.dirname(pluginDir));
                console.log('Vault Base Path:', vaultBasePath);

                if (!vaultBasePath) {
                    throw new Error('Obsidianボールトのパスが取得できません');
                }

                const absoluteAudioDir = path.isAbsolute(settings.audioDir)
                    ? settings.audioDir
                    : path.join(vaultBasePath, settings.audioDir);
                console.log('Absolute Audio Directory:', absoluteAudioDir);

                // ディレクトリの存在確認
                const dirExists = await fs.promises.access(path.dirname(absoluteAudioDir))
                    .then(() => true)
                    .catch(() => false);
                console.log('Parent Directory Exists:', dirExists);

                // 保存先ディレクトリの作成を試みる
                await fs.promises.mkdir(absoluteAudioDir, { recursive: true });
                console.log('Directory Created');

                const finalMp3Path = path.join(absoluteAudioDir, `${filename}.mp3`);
                console.log('Final MP3 Path:', finalMp3Path);

                // ソースファイルの存在確認
                if (!fs.existsSync(tempMp3Path)) {
                    throw new Error(`ソースファイルが見つかりません: ${tempMp3Path}`);
                }

                // MP3ファイルを最終的な保存先に移動
                await fs.promises.copyFile(tempMp3Path, finalMp3Path);
                console.log('File Copied Successfully');

                // ファイルが正しく保存されたか確認
                if (!fs.existsSync(finalMp3Path)) {
                    throw new Error('MP3ファイルの保存に失敗しました');
                }

                this.onProgressUpdate(`MP3ファイルを保存しました: ${finalMp3Path}`);
            } catch (error) {
                console.error('MP3ファイルの保存中にエラーが発生:', error);
                this.onError(`音声ファイルの保存に失敗しました: ${error.message}`);
                throw error;
            }

            // Transcribe the audio
            const transcription = await this.runTranscription(wavPath, settings);

            // MP3ファイルをバッファーとして読み取り
            const mp3Buffer = fs.readFileSync(tempMp3Path);

            try {
                // Clean up temp files
                fs.unlinkSync(tempFilePath);
                fs.unlinkSync(wavPath);
                fs.unlinkSync(tempMp3Path);
            } catch (error) {
                console.error('一時ファイルの削除中にエラーが発生:', error);
                // 一時ファイルの削除に失敗しても処理は続行
            }

            return {
                transcription: transcription,
                mp3Buffer: mp3Buffer
            };
        } catch (error) {
            console.error('音声処理に失敗:', error);
            throw error;
        }
    }

    public async transcribeExternalFile(
        filePath: string,
        settings: {
            language: string;
            modelSize: string;
        }
    ): Promise<string> {
        return this.runTranscription(filePath, settings);
    }

    private async convertToMp3(inputPath: string, filename: string): Promise<string> {
        const tempMp3Path = path.join(this.tempDir, `${filename}.mp3`);
        await new Promise<void>((resolve, reject) => {
            this.currentFfmpegCommand = ffmpeg(inputPath)
                .inputOptions([
                    '-f webm',  // 入力フォーマットを明示的に指定
                    '-c:a opus',  // Web Audio APIのデフォルトコーデック
                    '-analyzeduration 0',  // 入力ファイルの解析時間を短縮
                    '-probesize 32768'  // プローブサイズを小さく設定
                ])
                .toFormat('mp3')
                .audioCodec('libmp3lame')
                .audioBitrate(192)
                .on('progress', (progress: FFmpegProgress) => {
                    const percent = progress.percent || 0;
                    this.onProgressUpdate(`Converting to mp3: ${Math.round(percent)}% done`);
                })
                .on('error', (err: Error) => {
                    console.error('FFmpeg mp3 error:', err);
                    reject(err);
                })
                .on('end', () => {
                    this.currentFfmpegCommand = null;
                    resolve();
                })
                .save(tempMp3Path);
        });
        return tempMp3Path;
    }

    private async convertToWav(inputPath: string): Promise<string> {
        const wavFilePath = inputPath.replace('.webm', '_converted.wav');
        await new Promise<void>((resolve, reject) => {
            this.currentFfmpegCommand = ffmpeg(inputPath)
                .inputOptions([
                    '-f webm',  // 入力フォーマットを明示的に指定
                    '-c:a opus',  // Web Audio APIのデフォルトコーデック
                    '-analyzeduration 0',  // 入力ファイルの解析時間を短縮
                    '-probesize 32768'  // プローブサイズを小さく設定
                ])
                .toFormat('wav')
                .audioCodec('pcm_s16le')
                .audioFrequency(16000)
                .audioChannels(1)
                .on('progress', (progress: FFmpegProgress) => {
                    const percent = progress.percent || 0;
                    this.onProgressUpdate(`Converting to wav: ${Math.round(percent)}% done`);
                })
                .on('error', (err: Error) => {
                    console.error('FFmpeg wav error:', err);
                    reject(err);
                })
                .on('end', () => {
                    this.currentFfmpegCommand = null;
                    resolve();
                })
                .save(wavFilePath);
        });
        return wavFilePath;
    }

    private async runTranscription(
        audioPath: string,
        settings: {
            language: string;
            modelSize: string;
        }
    ): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            if (!fs.existsSync(this.mlxWhisperPath)) {
                reject(new Error(`MLX Whisperが見つかりません: ${this.mlxWhisperPath}`));
                return;
            }

            const venvPython = path.join(this.venvPath, "bin", "python3");
            if (!fs.existsSync(venvPython)) {
                reject(new Error(`Python interpreterが見つかりません: ${venvPython}`));
                return;
            }

            // MLX Whisperは入力ファイル名をベースに出力ファイルを生成
            const outputName = path.basename(audioPath, path.extname(audioPath));
            const outputPath = path.join(this.tempDir, `${outputName}.txt`);
            const command = [
                this.mlxWhisperPath,
                audioPath,
                "--model", `mlx-community/whisper-${settings.modelSize}-v3-turbo`,
                "--language", settings.language,
                "--output-format", "txt",
                "--output-dir", this.tempDir,
                "--verbose", "False"
            ];

            this.currentChildProcess = spawn(venvPython, command, {
                env: {
                    ...process.env,
                    PATH: `/opt/homebrew/bin:${process.env.PATH || ''}`
                }
            });

            let transcription = '';

            this.currentChildProcess.stdout.on('data', (data: Buffer) => {
                const output = data.toString();
                const progressMatch = output.match(/Progress: (\d+)%/);
                if (progressMatch) {
                    this.onProgressUpdate(`文字起こし中... ${progressMatch[1]}%`);
                }
                transcription += output;
            });

            this.currentChildProcess.stderr.on('data', (data: Buffer) => {
                const output = data.toString();
                // %で終わる行は進捗情報として処理
                if (output.includes('%')) {
                    const progressMatch = output.match(/(\d+)%/);
                    if (progressMatch) {
                        this.onProgressUpdate(`文字起こし中... ${progressMatch[1]}%`);
                    }
                } else if (output.includes('Error') || output.includes('error')) {
                    // 実際のエラーメッセージのみを表示
                    console.error(`Transcription Error: ${output}`);
                    this.onError(`文字起こし中にエラーが発生しました: ${output}`);
                }
            });

            this.currentChildProcess.on('close', async (code: number) => {
                if (code === 0) {
                    try {
                        // 出力ファイルの存在確認と読み取り
                        if (fs.existsSync(outputPath)) {
                            const result = await fs.promises.readFile(outputPath, 'utf-8');
                            resolve(result.trim());
                            // 一時ファイルを削除
                            fs.promises.unlink(outputPath).catch(console.error);
                        } else {
                            reject(new Error('文字起こし結果のファイルが見つかりません'));
                        }
                    } catch (error) {
                        reject(new Error(`文字起こし結果の読み取りに失敗: ${error.message}`));
                    }
                } else {
                    const errorMsg = transcription.includes('Error:')
                        ? transcription.match(/Error: (.*?)$/m)?.[1] || 'Unknown error'
                        : transcription;
                    reject(new Error(`Transcription failed: ${errorMsg}`));
                }
                this.currentChildProcess = null;
            });
        });
    }
}
