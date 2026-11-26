import { useState } from 'react';
import {
  leaveVoiceMesh,
  toggleAudioMuted,
  toggleCamera,
  toggleDeafened,
} from '../net/voice.js';
import { VOICE_STATUS, useVoice } from '../store/voiceStore.js';
import { IconButton } from './Primitives.jsx';
import ToolIcon from './ToolIcon.jsx';

export default function VoiceCallToolbar({ role }) {
  const status = useVoice((s) => s.status);
  const localAudioMuted = useVoice((s) => s.localAudioMuted);
  const localDeafened = useVoice((s) => s.localDeafened);
  const localVideoEnabled = useVoice((s) => s.localVideoEnabled);
  const listenOnly = useVoice((s) => s.listenOnly);
  const [cameraError, setCameraError] = useState('');

  if (status !== VOICE_STATUS.CONNECTED && status !== VOICE_STATUS.RECONNECTING) {
    return null;
  }

  const isDM = role === 'DM' || role === 'dm';

  async function handleToggleCamera() {
    setCameraError('');
    const res = await toggleCamera();
    if (res && !res.ok && res.error) {
      setCameraError(res.error);
    }
  }

  return (
    <nav
      className={`voice-call-toolbar ${isDM ? 'is-dm-top' : 'is-player-bottom'}`}
      aria-label="Voice and video call controls"
    >
      <IconButton
        label={
          listenOnly
            ? 'No microphone detected (listen-only)'
            : localAudioMuted
              ? 'Unmute microphone'
              : 'Mute microphone'
        }
        title={
          listenOnly
            ? 'No microphone detected (listen-only)'
            : localAudioMuted
              ? 'Unmute microphone'
              : 'Mute microphone'
        }
        disabled={listenOnly}
        aria-pressed={localAudioMuted}
        onClick={() => toggleAudioMuted()}
      >
        <ToolIcon name={localAudioMuted ? 'micOff' : 'mic'} />
      </IconButton>

      <IconButton
        label={localDeafened ? 'Undeafen voice chat' : 'Deafen voice chat'}
        title={localDeafened ? 'Undeafen voice chat' : 'Deafen voice chat'}
        aria-pressed={localDeafened}
        onClick={() => toggleDeafened()}
      >
        <ToolIcon name={localDeafened ? 'headphonesOff' : 'headphones'} />
      </IconButton>

      <IconButton
        label={localVideoEnabled ? 'Turn camera off' : 'Turn camera on'}
        title={
          cameraError ||
          (localVideoEnabled ? 'Turn camera off' : 'Turn camera on (480p @ 20fps)')
        }
        aria-pressed={localVideoEnabled}
        onClick={handleToggleCamera}
      >
        <ToolIcon name={localVideoEnabled ? 'camera' : 'cameraOff'} />
      </IconButton>

      <IconButton
        className="icon-button is-danger"
        label="Disconnect from voice call"
        title="Disconnect from voice call"
        onClick={() => leaveVoiceMesh()}
      >
        <ToolIcon name="phoneOff" />
      </IconButton>
    </nav>
  );
}
