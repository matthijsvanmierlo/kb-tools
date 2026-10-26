import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { AdaptiveEngine } from '../src/core/adaptive-engine.js';
import { CartridgeBridge } from '../src/core/cartridge-bridge.js';
import { LanBeacon } from '../src/core/lan-beacon.js';
import jszipLib from 'jszip';

const JSZip = jszipLib.default || jszipLib;

describe('Phase 4: Adaptive Engine, LMS Cartridges, and In-Room LAN Beacons', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('Initiative #9: Prerequisites & Adaptive Mastery Engine', () => {
    it('evaluates prerequisites and unlocks items when score threshold is satisfied', () => {
      const items = [
        { id: 'quiz-1', title: 'Quiz 1: Cells', points: 100 },
        {
          id: 'quiz-2',
          title: 'Quiz 2: Photosynthesis',
          points: 100,
          prerequisites: {
            item_ids: ['quiz-1'],
            min_score: 80
          }
        }
      ];

      // Scenario A: Student hasn't taken Quiz 1 yet
      const ledgerEmpty = [];
      const accessA = AdaptiveEngine.evaluateItemAccess(items[1], ledgerEmpty, items);
      expect(accessA.unlocked).toBe(false);
      expect(accessA.reason).toBe('NOT_COMPLETED');
      expect(accessA.missingItemTitle).toBe('Quiz 1: Cells');

      // Scenario B: Student scored 65% on Quiz 1 (below 80% threshold)
      const ledgerLow = [{ assignment_id: 'quiz-1', percent: 65, points: 65 }];
      const accessB = AdaptiveEngine.evaluateItemAccess(items[1], ledgerLow, items);
      expect(accessB.unlocked).toBe(false);
      expect(accessB.reason).toBe('SCORE_INSUFFICIENT');
      expect(accessB.currentScore).toBe(65);
      expect(accessB.requiredScore).toBe(80);

      // Scenario C: Student scored 85% on Quiz 1 (satisfies threshold)
      const ledgerPass = [{ assignment_id: 'quiz-1', percent: 85, points: 85 }];
      const accessC = AdaptiveEngine.evaluateItemAccess(items[1], ledgerPass, items);
      expect(accessC.unlocked).toBe(true);
    });

    it('calculates overall course completion percentage accurately', () => {
      const items = [
        { id: 'i1', title: 'Intro' },
        { id: 'i2', title: 'Chapter 1' },
        { id: 'i3', title: 'Chapter 2' },
        { id: 'i4', title: 'Final' }
      ];
      const ledger = [
        { assignment_id: 'i1', points: 100 },
        { assignment_id: 'i2', points: 90 }
      ];

      const progress = AdaptiveEngine.calculateCourseProgress(items, ledger);
      expect(progress.total).toBe(4);
      expect(progress.completed).toBe(2);
      expect(progress.percent).toBe(50);
    });
  });

  describe('Initiative #8: Universal LMS Cartridge Bridge (IMS CC & Standalone Packs)', () => {
    it('exports standalone zero-server runnable HTML package', () => {
      const course = { id: 'c-off', name: 'AP Physics Offline', color: '#10b981' };
      const units = [{ id: 'u1', title: 'Mechanics', course_id: 'c-off' }];
      const items = [{ id: 'it1', unit_id: 'u1', title: 'Newtonian Dynamics', kind: 'task', points: 100 }];

      const html = CartridgeBridge.exportStandaloneHtmlCourse({ course, units, items });

      expect(typeof html).toBe('string');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('AP Physics Offline');
      expect(html).toContain('Newtonian Dynamics');
      expect(html).toContain('id="kb-course-data"');
      expect(html).toContain('Zero-Server Pack');
      // No external CDN scripts allowed
      expect(html).not.toContain('https://cdn.');
    });

    it('imports IMS Common Cartridge zip package', async () => {
      const zip = new JSZip();
      const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="M_COURSE_101" xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1" xmlns:lom="http://ltsc.ieee.org/xsd/imsccv1p1/LOM/resource">
  <metadata>
    <lom:general>
      <lom:title><lom:string>Biology 101 Honors</lom:string></lom:title>
      <lom:description><lom:string>Introductory honors biology course.</lom:string></lom:description>
    </lom:general>
  </metadata>
  <organizations>
    <organization identifier="org_1">
      <item identifier="unit_1">
        <title>Cell Biology</title>
        <item identifier="lesson_1" identifierref="res_1">
          <title>Cell Membranes</title>
        </item>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res_1" type="webcontent" href="content/cells.html" />
  </resources>
</manifest>`;

      zip.file('imsmanifest.xml', manifestXml);
      zip.file('content/cells.html', '<h1>Cell Structure</h1><p>Lipid bilayers and transport mechanisms.</p>');

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const imported = await CartridgeBridge.importCommonCartridge(zipBlob);

      expect(imported.course).toBeDefined();
      expect(imported.course.name).toBe('Biology 101 Honors');
      expect(imported.units).toHaveLength(1);
      expect(imported.units[0].title).toBe('Cell Biology');
      expect(imported.items).toHaveLength(1);
      expect(imported.items[0].title).toBe('Cell Membranes');
      expect(imported.items[0].content.text_md).toContain('Lipid bilayers');
    });
  });

  describe('Initiative #5: Zero-Config In-Room LAN & WebRTC Submissions Beacon', () => {
    it('creates in-room beacon and receives direct student submissions', async () => {
      const room = LanBeacon.createSubmissionRoom({
        taskId: 'task-lab-exp',
        classId: 'class-period-3',
        title: 'Chemistry Titration Lab'
      });

      expect(room.roomId).toMatch(/^room-/);
      expect(room.pin).toHaveLength(4);
      expect(room.qrPayload).toContain(room.roomId);

      let receivedDetail = null;
      const unsubscribe = LanBeacon.onSubmissionReceived((sub) => {
        receivedDetail = sub;
      });

      const studentId = 'STU_CHARLIE';
      const ciphertext = 'KBSUB1.SAMPLE_CIPHERTEXT_XYZ_123';

      // Test incorrect pin rejection
      await expect(
        LanBeacon.submitToRoom({
          roomId: room.roomId,
          pin: '0000',
          studentId,
          ciphertext
        })
      ).rejects.toThrow('Incorrect in-room session PIN.');

      // Test valid submission with correct PIN
      const res = await LanBeacon.submitToRoom({
        roomId: room.roomId,
        pin: room.pin,
        studentId,
        ciphertext
      });

      expect(res.success).toBe(true);
      expect(res.receiptId).toContain('LAN-');
      expect(receivedDetail).not.toBeNull();
      expect(receivedDetail.student_id).toBe('STU_CHARLIE');
      expect(receivedDetail.ciphertext).toBe(ciphertext);

      unsubscribe();
      LanBeacon.closeRoom(room.roomId);
    });

    it('returns Access-Control-Allow-Private-Network header on PNA preflight', async () => {
      const { createRelayFetchHandler } = await import('../server/relay/handler.js');
      const handler = createRelayFetchHandler({ allowedOrigins: ['*'] });
      const req = new Request('http://localhost:3000/health', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://example.com',
          'Access-Control-Request-Private-Network': 'true'
        }
      });
      const res = await handler(req);
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
    });
  });
});
