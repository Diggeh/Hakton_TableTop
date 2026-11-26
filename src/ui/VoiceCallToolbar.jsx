import { useEffect, useRef, useState } from 'react';
import {
  leaveVoiceMesh,
  refreshMediaDevices,
  selectAudioInputDevice,
  selectVideoInputDevice,
  toggleAudioMuted,
  toggleCamera,
  toggleDeafened,
} from '../net/voice.js';
import { VOICE_STATUS, useVoice } from '../store/voiceStore.js';
import { IconButton } from './Primitives.jsx';
import ToolIcon from './ToolIcon.jsx';

function buildMenuDevices(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const defaultEntry = list.find((d) => d.isDefault || !d.deviceId);
  const defaultSubLabel =
    defaultEntry?.label && defaultEntry.label !== 'System Default'
      ? defaultEntry.label
      : null;

  const rest = list.filter((d) => !d.isDefault);
  return [
    {
      deviceId: '',
      label: defaultSubLabel || 'System Default',
      isSystemDefault: true,
    },
    ...rest,
  ];
}

function DevicePickerPopover({
  title,
  devices,
  selectedDeviceId,
  switching,
  errorMessage,
  onSelect,
}) {
  const options = buildMenuDevices(devices);

  return (
    <div className="voice-device-popover" role="menu" aria-label={title}>
      <div className="voice-device-header">
        <strong>{title}</strong>
      </div>
      <div className="voice-device-list">
        {options.map((device, index) => {
          const isSelected = (selectedDeviceId || '') === (device.deviceId || '');
          const key = device.deviceId || `default-${index}`;
          return (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={isSelected}
              className={`voice-device-option ${isSelected ? 'is-selected' : ''}`}
              disabled={switching}
              title={device.label}
              onClick={() => onSelect(device.deviceId)}
            >
              <span className="voice-device-label">{device.label}</span>
              <span className="voice-device-check" aria-hidden="true">
                {isSelected && <ToolIcon name="check" />}
              </span>
            </button>
          );
        })}
      </div>
      {errorMessage && (
        <div className="voice-device-error" role="status">
          {errorMessage}
        </div>
      )}
    </div>
  );
}

export default function VoiceCallToolbar({ role, variant = 'board' }) {
  const status = useVoice((s) => s.status);
  const popoutOpen = useVoice((s) => s.popoutOpen);
  const localAudioMuted = useVoice((s) => s.localAudioMuted);
  const localDeafened = useVoice((s) => s.localDeafened);
  const localVideoEnabled = useVoice((s) => s.localVideoEnabled);
  const listenOnly = useVoice((s) => s.listenOnly);
  const audioInputs = useVoice((s) => s.audioInputs);
  const videoInputs = useVoice((s) => s.videoInputs);
  const selectedAudioInputId = useVoice((s) => s.selectedAudioInputId);
  const selectedVideoInputId = useVoice((s) => s.selectedVideoInputId);

  const [cameraError, setCameraError] = useState('');
  const [togglingCamera, setTogglingCamera] = useState(false);
  const [openMenu, setOpenMenu] = useState(null);
  const [deviceError, setDeviceError] = useState('');
  const [switchingDevice, setSwitchingDevice] = useState(false);
  const toolbarRef = useRef(null);

  const active = status === VOICE_STATUS.CONNECTED || status === VOICE_STATUS.RECONNECTING;
  const hiddenForPopout = variant !== 'popout' && popoutOpen;
  const visible = active && !hiddenForPopout;

  useEffect(() => {
    if (!visible) {
      setOpenMenu(null);
      setDeviceError('');
      return undefined;
    }
    const navDevices = globalThis.navigator?.mediaDevices;
    const onDeviceChange = () => {
      void refreshMediaDevices();
    };
    navDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => navDevices?.removeEventListener?.('devicechange', onDeviceChange);
  }, [visible]);

  useEffect(() => {
    if (!openMenu) return undefined;
    const ownerWin = toolbarRef.current?.ownerDocument?.defaultView ?? window;
    const handlePointerDown = (event) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target)) {
        setOpenMenu(null);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
      }
    };
    ownerWin.addEventListener('pointerdown', handlePointerDown);
    ownerWin.addEventListener('keydown', handleKeyDown);
    return () => {
      ownerWin.removeEventListener('pointerdown', handlePointerDown);
      ownerWin.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!cameraError) return undefined;
    const timer = setTimeout(() => setCameraError(''), 6000);
    return () => clearTimeout(timer);
  }, [cameraError]);

  if (!visible) {
    return null;
  }

  const isDM = role === 'DM' || role === 'dm';
  const positionClass =
    variant === 'popout' ? 'is-popout-bottom' : isDM ? 'is-dm-top' : 'is-player-bottom';

  async function handleToggleCamera() {
    if (togglingCamera) return;
    setCameraError('');
    setTogglingCamera(true);
    try {
      const res = await toggleCamera();
      if (res && !res.ok && res.error) {
        setCameraError(res.error);
      }
    } finally {
      setTogglingCamera(false);
    }
  }

  function handleToggleMenu(menu) {
    setDeviceError('');
    setOpenMenu((prev) => {
      const next = prev === menu ? null : menu;
      if (next) {
        void refreshMediaDevices();
      }
      return next;
    });
  }

  async function handleSelectAudioInput(deviceId) {
    setDeviceError('');
    setSwitchingDevice(true);
    try {
      const res = await selectAudioInputDevice(deviceId);
      if (res && !res.ok) {
        setDeviceError(res.error || 'Could not switch microphone.');
        return;
      }
      setOpenMenu(null);
    } finally {
      setSwitchingDevice(false);
    }
  }

  async function handleSelectVideoInput(deviceId) {
    setDeviceError('');
    setSwitchingDevice(true);
    try {
      const res = await selectVideoInputDevice(deviceId);
      if (res && !res.ok) {
        setDeviceError(res.error || 'Could not switch camera.');
        return;
      }
      setOpenMenu(null);
    } finally {
      setSwitchingDevice(false);
    }
  }

  return (
    <nav
      ref={toolbarRef}
      className={`voice-call-toolbar ${positionClass}`}
      aria-label="Voice and video call controls"
    >
      <div className="voice-split-anchor">
        <div className={`voice-split-control ${openMenu === 'mic' ? 'is-open' : ''}`}>
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
          <button
            type="button"
            className={`voice-split-chevron ${openMenu === 'mic' ? 'is-open' : ''}`}
            title="Choose microphone"
            aria-label="Choose microphone"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'mic'}
            onClick={() => handleToggleMenu('mic')}
          >
            <ToolIcon name="chevronDown" />
          </button>
        </div>
        {openMenu === 'mic' && (
          <DevicePickerPopover
            title="Input Device"
            devices={audioInputs}
            selectedDeviceId={selectedAudioInputId}
            switching={switchingDevice}
            errorMessage={deviceError}
            onSelect={handleSelectAudioInput}
          />
        )}
      </div>

      <IconButton
        label={localDeafened ? 'Undeafen voice chat' : 'Deafen voice chat'}
        title={localDeafened ? 'Undeafen voice chat' : 'Deafen voice chat'}
        aria-pressed={localDeafened}
        onClick={() => toggleDeafened()}
      >
        <ToolIcon name={localDeafened ? 'headphonesOff' : 'headphones'} />
      </IconButton>

      <div className="voice-split-anchor">
        <div className={`voice-split-control ${openMenu === 'camera' ? 'is-open' : ''}`}>
          <IconButton
            label={localVideoEnabled ? 'Turn camera off' : 'Turn camera on'}
            title={
              cameraError ||
              (localVideoEnabled ? 'Turn camera off' : 'Turn camera on (480p @ 20fps)')
            }
            disabled={togglingCamera}
            aria-busy={togglingCamera}
            aria-pressed={localVideoEnabled}
            onClick={handleToggleCamera}
          >
            <ToolIcon name={localVideoEnabled ? 'camera' : 'cameraOff'} />
          </IconButton>
          <button
            type="button"
            className={`voice-split-chevron ${openMenu === 'camera' ? 'is-open' : ''}`}
            title="Choose camera"
            aria-label="Choose camera"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'camera'}
            onClick={() => handleToggleMenu('camera')}
          >
            <ToolIcon name="chevronDown" />
          </button>
        </div>
        {openMenu === 'camera' && (
          <DevicePickerPopover
            title="Camera"
            devices={videoInputs}
            selectedDeviceId={selectedVideoInputId}
            switching={switchingDevice}
            errorMessage={deviceError || cameraError}
            onSelect={handleSelectVideoInput}
          />
        )}
      </div>

      <IconButton
        className="icon-button is-danger"
        label="Disconnect from voice call"
        title="Disconnect from voice call"
        onClick={() => leaveVoiceMesh()}
      >
        <ToolIcon name="phoneOff" />
      </IconButton>

      {cameraError && !openMenu && (
        <div className="voice-toolbar-error" role="alert">
          <span>{cameraError}</span>
          <button
            type="button"
            className="voice-toolbar-error-close"
            aria-label="Dismiss camera error"
            onClick={() => setCameraError('')}
          >
            ×
          </button>
        </div>
      )}
    </nav>
  );
}
