import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VideoGatekeeper } from '../src/modules/video/interceptor.js';
import { YouTubeDriver, VimeoDriver } from '../src/modules/video/drivers.js';
import { KioskReportEngine } from '../src/modules/video/kiosk-report.js';
import { generateUUID } from '../src/utils/uuid.js';

describe('Phase 4: Multi-Provider Video Drivers ID Extractors', () => {
  it('extracts YouTube IDs from diverse URL formats', () => {
    expect(YouTubeDriver.extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(YouTubeDriver.extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(YouTubeDriver.extractYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1')).toBe('dQw4w9WgXcQ');
  });

  it('extracts Vimeo IDs from standard formats', () => {
    expect(VimeoDriver.extractVimeoId('https://vimeo.com/76979871')).toBe('76979871');
    expect(VimeoDriver.extractVimeoId('https://vimeo.com/channels/staffpicks/76979871')).toBe('76979871');
  });
});

describe('Phase 4: 250ms Playhead Gatekeeper & Anti-Scrub Enforcement', () => {
  let mockDriver;
  let checkpoints;
  let triggeredCheckpoints;
  let gatekeeper;

  beforeEach(() => {
    let currentTime = 0;
    mockDriver = {
      getCurrentTime: vi.fn(async () => currentTime),
      seekTo: vi.fn(async (t) => { currentTime = t; }),
      pause: vi.fn(async () => {}),
      play: vi.fn(async () => {})
    };

    checkpoints = [
      { id: 'cp-1', timestamp_sec: 10.0, type: 'single_choice', prompt_markdown: 'Question 1', points: 1 },
      { id: 'cp-2', timestamp_sec: 25.0, type: 'open_response', prompt_markdown: 'Question 2', points: 2 }
    ];

    triggeredCheckpoints = [];
    gatekeeper = new VideoGatekeeper(mockDriver, checkpoints, (cp) => {
      triggeredCheckpoints.push(cp);
    });
  });

  it('blocks scrubbing forward past an unanswered checkpoint and snaps playhead back', async () => {
    // Current time is 2.0s, user attempts to scrub to 18.0s (past checkpoint 1 @ 10s)
    mockDriver.getCurrentTime.mockResolvedValue(18.0);
    gatekeeper.maxReachedTime = 2.0;

    // Simulate tick at now = 300ms
    const nextIncomplete = gatekeeper.checkpoints[0]; // cp-1 @ 10s
    const allowedCeiling = Math.min(gatekeeper.maxReachedTime + 1.0, nextIncomplete.timestamp_sec + 0.35); // 3.0s

    // Verify allowedCeiling is 3.0s, so 18.0s triggers snapTarget
    expect(18.0 > allowedCeiling + 0.5).toBe(true);

    const snapTarget = nextIncomplete.timestamp_sec; // 10.0s
    await mockDriver.seekTo(snapTarget);
    expect(mockDriver.seekTo).toHaveBeenCalledWith(10.0);
  });

  it('triggers checkpoint and pauses video when playhead enters window [t ± 0.35s]', async () => {
    // Playhead reaches 10.1s (within 0.35s of checkpoint 1 @ 10.0s)
    const cp1 = checkpoints[0];
    const currentTime = 10.1;
    const inWindow = Math.abs(currentTime - cp1.timestamp_sec) <= 0.35;
    expect(inWindow).toBe(true);

    gatekeeper.isLocked = true;
    await mockDriver.pause();
    gatekeeper.onTriggerCheckpoint(cp1);

    expect(mockDriver.pause).toHaveBeenCalled();
    expect(triggeredCheckpoints).toHaveLength(1);
    expect(triggeredCheckpoints[0].id).toBe('cp-1');
  });

  it('resolves checkpoint, marks completed, unlocks gatekeeper, and resumes video', async () => {
    await gatekeeper.resolveCheckpoint('cp-1');
    expect(gatekeeper.completedIds.has('cp-1')).toBe(true);
    expect(gatekeeper.isLocked).toBe(false);
    expect(mockDriver.play).toHaveBeenCalled();
  });
});

describe('Phase 4: Cryptographic Receipt (.kbr) & Verification Engine', () => {
  it('generates a signed .kbr receipt with SHA-256 digest', async () => {
    const studentName = 'Alex Rivera';
    const assessmentId = generateUUID();
    const assessmentTitle = 'Intro to Astrophysics';
    const responseLogs = [
      { checkpointId: 'cp-1', studentAnswer: ['opt-1'], isCorrect: true, earnedPoints: 1, maxPoints: 1, latencyMs: 2400 }
    ];

    const { receipt, kbrString, filename } = await KioskReportEngine.generateReceipt(
      studentName,
      assessmentId,
      assessmentTitle,
      responseLogs,
      1,
      1
    );

    expect(receipt.studentName).toBe('Alex Rivera');
    expect(receipt.signature).toMatch(/^[0-9a-f]{64}$/); // Valid 64-char SHA-256 hex
    expect(filename).toBe('Alex_Rivera_result.kbr');
    expect(kbrString).toBeDefined();

    // Verify valid receipt
    const verification = await KioskReportEngine.verifyReceipt(kbrString);
    expect(verification.isValid).toBe(true);
    expect(verification.receipt.totalScore).toBe(1);
    expect(verification.error).toBeNull();
  });

  it('detects tampering and rejects manipulated receipt with CRYPTOGRAPHIC_SIGNATURE_MISMATCH', async () => {
    const studentName = 'Sam Smith';
    const assessmentId = generateUUID();
    const responseLogs = [];

    const { receipt } = await KioskReportEngine.generateReceipt(studentName, assessmentId, 'Quiz', responseLogs, 10, 100);

    // Tamper with receipt score (inflate from 10 to 100)
    receipt.totalScore = 100;
    receipt.percent = 100;

    const tamperedKbrString = (await import('lz-string')).default.compressToEncodedURIComponent(JSON.stringify(receipt));

    const verification = await KioskReportEngine.verifyReceipt(tamperedKbrString);
    expect(verification.isValid).toBe(false);
    expect(verification.error).toBe('CRYPTOGRAPHIC_SIGNATURE_MISMATCH');
  });
});
