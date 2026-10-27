import { key } from '../src/config.js';
import { voiceOverPreflight } from '../src/voiceover.js';
import { webkit } from 'playwright';
import { existsSync } from 'node:fs';
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      browserInstalled: existsSync(webkit.executablePath()),
      metaKeyPresent: !!key(),
      paidApprovalPresent: existsSync('spend-approval.json'),
      paidTestingAuthorised: false,
      voiceOver: voiceOverPreflight(),
      next: 'Offline tests do not need an API key. Actual VoiceOver needs the normal Mac permissions and matching Guidepup assets.',
    },
    null,
    2,
  ),
);
