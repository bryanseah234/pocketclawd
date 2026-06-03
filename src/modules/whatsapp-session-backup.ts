/**
 * WhatsApp session backup — syncs Baileys auth directory to S3.
 * Runs every 5 minutes to ensure session survives container restarts.
 */
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { log } from '../log.js';

export interface SessionBackupConfig {
  s3Bucket: string;
  s3Prefix: string;
  localAuthDir: string;
  region: string;
}

function contentType(filename: string): string {
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.key') || filename.endsWith('.bin')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function listFilesRecursive(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...listFilesRecursive(full, base));
    else files.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return files;
}

export class WhatsAppSessionBackup {
  private s3: S3Client;
  private config: SessionBackupConfig;

  constructor(config: SessionBackupConfig) {
    this.config = config;
    this.s3 = new S3Client({ region: config.region });
  }

  async backup(): Promise<{ uploaded: string[]; errors: string[] }> {
    const uploaded: string[] = [];
    const errors: string[] = [];
    const files = listFilesRecursive(this.config.localAuthDir);
    for (const relPath of files) {
      try {
        const fullPath = path.join(this.config.localAuthDir, relPath);
        const body = fs.readFileSync(fullPath);
        const key = `${this.config.s3Prefix}${relPath}`;
        await this.s3.send(new PutObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: key,
          Body: body,
          ContentType: contentType(relPath),
        }));
        uploaded.push(relPath);
      } catch (e) {
        // Skip files that vanished between listing and reading (Signal pre-key rotation
        // deletes consumed pre-keys mid-backup — this is expected behaviour, not an error).
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        errors.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { uploaded, errors };
  }

  async restore(): Promise<{ restored: string[]; errors: string[] }> {
    const restored: string[] = [];
    const errors: string[] = [];
    try {
      const list = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.config.s3Bucket,
        Prefix: this.config.s3Prefix,
      }));
      for (const obj of list.Contents ?? []) {
        const key = obj.Key!;
        const relPath = key.slice(this.config.s3Prefix.length);
        if (!relPath) continue;
        const localPath = path.join(this.config.localAuthDir, relPath.replace(/\//g, path.sep));
        try {
          // Skip if local is newer
          if (fs.existsSync(localPath) && obj.LastModified) {
            const localMtime = fs.statSync(localPath).mtime;
            if (localMtime >= obj.LastModified) continue;
          }
          const resp = await this.s3.send(new GetObjectCommand({
            Bucket: this.config.s3Bucket,
            Key: key,
          }));
          const chunks: Buffer[] = [];
          for await (const chunk of resp.Body as Readable) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          fs.writeFileSync(localPath, Buffer.concat(chunks));
          restored.push(relPath);
        } catch (e) {
          errors.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      errors.push(`list: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { restored, errors };
  }

  /** Wipe all session files from S3. Used when admin clicks Disconnect (force re-pair). */
  async purge(): Promise<{ deleted: string[]; errors: string[] }> {
    const deleted: string[] = [];
    const errors: string[] = [];
    try {
      const list = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.config.s3Bucket,
        Prefix: this.config.s3Prefix,
      }));
      for (const obj of list.Contents ?? []) {
        const key = obj.Key!;
        try {
          await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
          deleted.push(key);
        } catch (e) {
          errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      errors.push(`list: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { deleted, errors };
  }

  startPeriodicBackup(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
    return setInterval(() => {
      this.backup().catch((e) => log.error('[session-backup] periodic error', { err: e instanceof Error ? e.message : String(e) }));
    }, intervalMs);
  }

  stopPeriodicBackup(timer: NodeJS.Timeout): void {
    clearInterval(timer);
  }
}

export function createSessionBackup(config: SessionBackupConfig): WhatsAppSessionBackup {
  return new WhatsAppSessionBackup(config);
}
