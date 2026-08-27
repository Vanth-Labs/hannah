// src/components/AvatarBoundary.jsx
// r3f rethrows loader errors into the React tree: a truncated or corrupt avatar file made
// GLTFLoader throw, the whole app unmounted (blank overlay, WebSocket gone) and only a relaunch
// brought it back. This boundary catches that and falls back to the factory avatar; if the
// factory file itself fails, it renders nothing — the HUD and the voice keep working.
import { Component } from 'react';
import { useHannahStore } from '../store/hannahStore.js';

export const FACTORY_AVATAR = '/avatar.glb';

export class AvatarBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { failed: false };
    }

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error) {
        const st = useHannahStore.getState();
        console.warn('Avatar load failed:', error?.message || error);
        st.setAvatarError('load_failed');
        // Remounting with the factory file: Scene keys this boundary by URL, so a new URL
        // gives a fresh boundary (and the error state below only matters for the factory one).
        if (this.props.url !== FACTORY_AVATAR) st.setAvatarUrl(FACTORY_AVATAR);
    }

    render() {
        if (this.state.failed) return null;
        return this.props.children;
    }
}
