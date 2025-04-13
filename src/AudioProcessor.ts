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

            const buffer = Buffer.from(await audioBlob.arrayBuffer());
            await new Promise<void>((resolve, reject) => {
                const writeStream = fs.createWriteStream(tempFilePath);
                writeStream.write(buffer);
                writeStream.end();
                writeStream.on('finish', () => resolve());
                writeStream.on('error', (err) => reject(err));
            });

            const [tempMp3Path, wavPath] = await Promise.all([
                this.convertToMp3(tempFilePath, filename),
                this.convertToWav(tempFilePath)
            ]);

            try {
                const vaultBasePath = path.resolve(path.dirname(pluginDir));
                if (!vaultBasePath) {
                    throw new Error('Obsidianボールトのパスが取得できません');
                }

                const absoluteAudioDir = path.isAbsolute(settings.audioDir)
                    ? settings.audioDir
                    : path.join(vaultBasePath, settings.audioDir);

                await fs.promises.mkdir(absoluteAudioDir, { recursive: true });
                const finalMp3Path = path.join(absoluteAudioDir, `${filename}.mp3`);

                if (!fs.existsSync(tempMp3Path)) {
                    throw new Error(`ソースファイルが見つかりません: ${tempMp3Path}`);
                }

                await fs.promises.copyFile(tempMp3Path, finalMp3Path);
                if (!fs.existsSync(finalMp3Path)) {
                    throw new Error('MP3ファイルの保存に失敗しました');
                }

                this.onProgressUpdate(`MP3ファイルを保存しました: ${finalMp3Path}`);
            } catch (error) {
                console.error('MP3ファイルの保存中にエラーが発生:', error);
                this.onError(`音声ファイルの保存に失敗しました: ${error.message}`);
                throw error;
            }

            const transcription = await this.runTranscription(wavPath, settings);
            const mp3Buffer = fs.readFileSync(tempMp3Path);

            try {
                fs.unlinkSync(tempFilePath);
                fs.unlinkSync(wavPath);
                fs.unlinkSync(tempMp3Path);
            } catch (error) {
                console.error('一時ファイルの削除中にエラーが発生:', error);
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
                .inputOptions(['-f webm', '-c:a opus', '-analyzeduration 0', '-probesize 32768'])
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
                .inputOptions(['-f webm', '-c:a opus', '-analyzeduration 0', '-probesize 32768'])
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

    private formatTime(timeInSeconds: number): string {
        const hours = Math.floor(timeInSeconds / 3600);
        const minutes = Math.floor((timeInSeconds % 3600) / 60);
        const seconds = Math.floor(timeInSeconds % 60);
        return hours > 0
            ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
            : `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    private parseTimestamp(timestamp: string): number {
        // Format: [HH:]MM:SS.mmm
        const match = timestamp.match(/^(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})$/);
        if (!match) {
            console.error('Invalid timestamp format:', timestamp);
            return 0;
        }

        // match[1]が存在する場合は時間あり、存在しない場合は分から始まる
        const hours = match[1] ? parseInt(match[1], 10) : 0;
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        const milliseconds = parseInt(match[4], 10);

        const totalSeconds = (hours * 3600) + (minutes * 60) + seconds + (milliseconds / 1000);
        console.log('[parseTimestamp]', {
            input: timestamp,
            hours,
            minutes,
            seconds,
            milliseconds,
            totalSeconds,
            formatted: this.formatTime(totalSeconds)
        });
        return totalSeconds;
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

            const outputName = path.basename(audioPath, path.extname(audioPath));
            const outputPath = path.join(this.tempDir, `${outputName}.txt`);
            const command = [
                this.mlxWhisperPath,
                audioPath,
                "--model", `mlx-community/whisper-large-v3-turbo`,
                "--language", settings.language,
                "--output-format", "txt",
                "--output-dir", this.tempDir,
                "--condition-on-previous-text", "False"
            ];

            console.log('[Whisper Command]:', venvPython, command.join(' '));
            // PYTHONUNBUFFEREDを設定してPythonの出力バッファリングを無効化
            this.currentChildProcess = spawn(venvPython, command, {
                env: {
                    ...process.env,
                    PATH: `/opt/homebrew/bin:${process.env.PATH || ''}`,
                    PYTHONUNBUFFERED: '1'
                },
                stdio: ['pipe', 'pipe', 'pipe']  // 標準出力と標準エラー出力のバッファリングを制御
            });

            let transcription = '';
            let totalDuration: number | null = null;
            let lastProgressUpdate = 0;
            let processingStartTime = Date.now();

            console.log('[Transcription Start]:', new Date().toISOString());

            const getDuration = new Promise<void>((resolve) => {
                ffmpeg.ffprobe(audioPath, (err, metadata) => {
                    if (!err && metadata.format.duration) {
                        totalDuration = metadata.format.duration;
                        console.log('[Audio Duration]:', totalDuration, 'seconds');
                    } else if (err) {
                        console.error('[FFprobe error]:', err);
                    }
                    resolve();
                });
            });

            getDuration.then(() => {
                let buffer = '';
                this.currentChildProcess.stdout.on('data', (data: Buffer) => {
                    const output = data.toString();
                    buffer += output;
                    console.log('[Whisper stdout]:', output);

                    // バッファから完全な行を処理
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // 最後の不完全な行を保持

                    for (const line of lines) {
                        transcription += line + '\n';

                        // タイムスタンプの形式を[MM:SS.mmm]または[HH:MM:SS.mmm]に対応
                        const timestampMatch = line.match(/\[(?:(\d{2}):)?(\d{2}):(\d{2}\.\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2}\.\d{3})\]/);
                        if (timestampMatch) {
                            console.log('[Timestamp detected]:', {
                                raw: timestampMatch[0],
                                groups: timestampMatch.slice(1),
                                endTimeStr: timestampMatch[4]
                                    ? `${timestampMatch[4]}:${timestampMatch[5]}:${timestampMatch[6]}`
                                    : `${timestampMatch[2]}:${timestampMatch[3]}`,
                                containsHours: !!timestampMatch[4]
                            });
                            // 終了時間を使用（時間あり：4,5,6、時間なし：2,3）
                            const endTimeStr = timestampMatch[4]
                                ? `${timestampMatch[4]}:${timestampMatch[5]}:${timestampMatch[6]}`
                                : `${timestampMatch[2]}:${timestampMatch[3]}`;
                            const currentTime = this.parseTimestamp(endTimeStr);
                            // 時間が前に戻らないように確認
                            if (totalDuration && currentTime > lastProgressUpdate) {
                                lastProgressUpdate = currentTime;
                                const progress = Math.min(Math.round((currentTime / totalDuration) * 100), 100);
                                const elapsedTime = (Date.now() - processingStartTime) / 1000;
                                const currentTimeFormatted = this.formatTime(currentTime);
                                const totalTimeFormatted = totalDuration ? this.formatTime(totalDuration) : '0:00';

                                console.log('[Progress]:', {
                                    percent: progress,
                                    currentTime,
                                    totalDuration,
                                    lastUpdate: lastProgressUpdate,
                                    elapsedProcessingTime: elapsedTime.toFixed(1) + 's',
                                    currentLine: line
                                });
                                this.onProgressUpdate(
                                    `${currentTimeFormatted} / ${totalTimeFormatted} (${progress}%)`
                                );
                            } else {
                                this.onProgressUpdate('文字起こし中...');
                            }
                        }
                    }
                });

                this.currentChildProcess.stderr.on('data', (data: Buffer) => {
                    const output = data.toString();
                    console.log('[Whisper stderr]:', output);

                    // エラー検出
                    if (output.includes('Error') || output.includes('error')) {
                        console.error(`Transcription Error: ${output}`);
                        this.onError(`文字起こし中にエラーが発生しました: ${output}`);
                    }
                });

                this.currentChildProcess.on('close', async (code: number) => {
                    if (code === 0) {
                        try {
                            if (fs.existsSync(outputPath)) {
                                const result = await fs.promises.readFile(outputPath, 'utf-8');
                                // 結果をそのまま使用
                                const textContent = result.trim();
                                const processingTime = ((Date.now() - processingStartTime) / 1000).toFixed(1);
                                console.log('[Transcription Complete]:', {
                                    processingTime: `${processingTime}s`,
                                    contentLength: textContent.length
                                });
                                this.onProgressUpdate('文字起こしが完了しました');
                                resolve(textContent);
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
        });
    }
}
