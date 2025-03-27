import { FfmpegCommand } from 'fluent-ffmpeg';

// fluent-ffmpegの型定義を拡張
declare module 'fluent-ffmpeg' {
    interface FfmpegCommand {
        on(event: 'progress', callback: (progress: FFmpegProgress) => void): FfmpegCommand;
    }
}

// FFmpeg.Progress型を定義
export interface FFmpegProgress {
    frames?: number;
    currentFps?: number;
    currentKbps?: number;
    targetSize?: number;
    timemark?: string;
    percent?: number;
}

export interface WhisperPluginSettings {
    language: string;
    modelSize: string;
    audioDir: string;
}

export const DEFAULT_SETTINGS: WhisperPluginSettings = {
    language: 'ja',
    modelSize: 'base',
    audioDir: '04_assets/audio'
}
