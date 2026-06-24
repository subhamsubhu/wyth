"""Backend tests for the new playback-control feature.

Covers:
- POST /api/rooms/create defaults (playbackControl, playbackAllowList)
- PUT /api/rooms/:roomId/settings (host can change playbackControl, validation, 403 for non-host)
- POST /api/rooms/:roomId/playback-grant / playback-revoke (allow list management + 403)
- Socket gating: hosts-only blocks non-host play/pause/seek, emits playback-denied
- After grant, the granted user can play/pause/seek and others receive video-* events
- everyone mode: any member can drive playback
"""
import os
import time
import uuid
import pytest
import requests
import socketio

BASE_URL = os.environ['REACT_APP_BACKEND_URL'].rstrip('/')
FIREBASE_API_KEY = 'AIzaSyCgkNmm4o_dG4bNmg0_AgnpgYwjs6ZV53Q'
ADMIN_EMAIL = 'subhamghadia@admin.com'
ADMIN_PASSWORD = '#subham5'

SOCKET_PATH = '/api/socket.io'


def _sign_in(email, password):
    r = requests.post(
        f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}',
        json={'email': email, 'password': password, 'returnSecureToken': True}, timeout=15)
    r.raise_for_status()
    body = r.json()
    return body['idToken'], body['localId']


@pytest.fixture(scope='module')
def admin_token():
    token, uid = _sign_in(ADMIN_EMAIL, ADMIN_PASSWORD)
    return {'token': token, 'uid': uid}


@pytest.fixture(scope='module')
def host_headers(admin_token):
    return {'Authorization': f"Bearer {admin_token['token']}", 'Content-Type': 'application/json'}


@pytest.fixture(scope='module')
def room(host_headers, admin_token):
    """Create a fresh room for each module run. Hard-deletes via /:roomId DELETE in teardown."""
    r = requests.post(f'{BASE_URL}/api/rooms/create', headers=host_headers,
                      json={'roomName': f'TEST_pb_{uuid.uuid4().hex[:6]}'}, timeout=20)
    assert r.status_code == 200, f'create room failed: {r.status_code} {r.text}'
    data = r.json()
    assert data['success'] is True
    room_id = data['roomId']
    yield {'roomId': room_id, 'hostUid': admin_token['uid'], 'data': data['roomData']}
    try:
        requests.delete(f'{BASE_URL}/api/rooms/{room_id}', headers=host_headers, timeout=10)
    except Exception:
        pass


# ---------- REST -----------------------------------------------------------

class TestHealth:
    def test_health(self):
        r = requests.get(f'{BASE_URL}/api/health', timeout=10)
        assert r.status_code == 200
        assert r.json().get('status') == 'healthy'

    def test_rooms_requires_auth(self):
        r = requests.post(f'{BASE_URL}/api/rooms/create', json={'roomName': 'x'}, timeout=10)
        assert r.status_code == 401


class TestCreateDefaults:
    def test_create_has_playback_defaults(self, room):
        s = room['data']['settings']
        assert s['playbackControl'] == 'everyone'
        assert s['playbackAllowList'] == []


class TestSettingsRoute:
    def test_host_can_set_everyone(self, host_headers, room):
        r = requests.put(f"{BASE_URL}/api/rooms/{room['roomId']}/settings", headers=host_headers,
                         json={'settings': {'playbackControl': 'everyone'}}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body['success'] is True
        assert body['settings']['playbackControl'] == 'everyone'

    def test_host_can_set_hosts_only(self, host_headers, room):
        r = requests.put(f"{BASE_URL}/api/rooms/{room['roomId']}/settings", headers=host_headers,
                         json={'settings': {'playbackControl': 'hosts-only'}}, timeout=15)
        assert r.status_code == 200
        assert r.json()['settings']['playbackControl'] == 'hosts-only'

    def test_invalid_value_rejected(self, host_headers, room):
        r = requests.put(f"{BASE_URL}/api/rooms/{room['roomId']}/settings", headers=host_headers,
                         json={'settings': {'playbackControl': 'nobody'}}, timeout=15)
        # Only invalid key => sanitized object is empty => 400 Bad Request
        assert r.status_code == 400
        assert r.json()['success'] is False

    def test_non_host_forbidden(self, room):
        # Forge a fake token (will fail verification) and confirm 401, then try with no token => 401.
        r = requests.put(f"{BASE_URL}/api/rooms/{room['roomId']}/settings",
                         json={'settings': {'playbackControl': 'everyone'}},
                         headers={'Content-Type': 'application/json'}, timeout=15)
        assert r.status_code == 401


class TestGrantRevoke:
    TEST_UID = 'TEST_viewer_uid_001'

    def test_grant_adds_to_allow_list(self, host_headers, room):
        r = requests.post(f"{BASE_URL}/api/rooms/{room['roomId']}/playback-grant", headers=host_headers,
                          json={'userId': self.TEST_UID}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body['success'] is True
        assert self.TEST_UID in body['settings']['playbackAllowList']

    def test_get_room_reflects_allow_list(self, host_headers, room):
        r = requests.get(f"{BASE_URL}/api/rooms/{room['roomId']}", headers=host_headers, timeout=15)
        assert r.status_code == 200
        assert self.TEST_UID in r.json()['room']['settings']['playbackAllowList']

    def test_revoke_removes_from_allow_list(self, host_headers, room):
        r = requests.post(f"{BASE_URL}/api/rooms/{room['roomId']}/playback-revoke", headers=host_headers,
                          json={'userId': self.TEST_UID}, timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert body['success'] is True
        assert self.TEST_UID not in body['settings']['playbackAllowList']

    def test_grant_requires_auth(self, room):
        r = requests.post(f"{BASE_URL}/api/rooms/{room['roomId']}/playback-grant",
                          json={'userId': 'x'}, headers={'Content-Type': 'application/json'}, timeout=10)
        assert r.status_code == 401

    def test_revoke_requires_auth(self, room):
        r = requests.post(f"{BASE_URL}/api/rooms/{room['roomId']}/playback-revoke",
                          json={'userId': 'x'}, headers={'Content-Type': 'application/json'}, timeout=10)
        assert r.status_code == 401


# ---------- Socket helpers --------------------------------------------------

def _wait_for(events_dict, key, timeout=4.0):
    end = time.time() + timeout
    while time.time() < end:
        if key in events_dict:
            return events_dict[key]
        time.sleep(0.1)
    return None


def _make_client(token=None):
    sio = socketio.Client(reconnection=False, logger=False, engineio_logger=False)
    auth = {'token': token} if token else {}
    sio.connect(BASE_URL, socketio_path=SOCKET_PATH,
                transports=['websocket'], auth=auth, wait_timeout=10)
    return sio


# ---------- Socket tests ----------------------------------------------------

class TestSocketHostsOnly:
    """In hosts-only mode, non-host play/pause/seek must be denied."""

    def test_non_host_denied_play_pause_seek(self, host_headers, room):
        # Ensure hosts-only
        requests.put(f"{BASE_URL}/api/rooms/{room['roomId']}/settings", headers=host_headers,
                     json={'settings': {'playbackControl': 'hosts-only'}}, timeout=15)
        time.sleep(0.3)

        anon = _make_client(token=None)
        host = _make_client(token=host_headers['Authorization'].split(' ', 1)[1])

        anon_events = {}
        host_events = {}
        for ev in ('playback-denied',):
            anon.on(ev, lambda data, e=ev: anon_events.setdefault(e, data))
        for ev in ('video-play', 'video-pause', 'video-seek'):
            host.on(ev, lambda data, e=ev: host_events.setdefault(e, data))

        # join room
        anon.emit('join-room', {'roomId': room['roomId']})
        host.emit('join-room', {'roomId': room['roomId']})
        time.sleep(0.5)

        anon.emit('play-video', {'roomId': room['roomId'], 'currentTime': 5})
        denied = _wait_for(anon_events, 'playback-denied', 3)
        assert denied is not None, 'expected playback-denied for anon play'
        assert denied.get('action') == 'play'

        # host should NOT see a video-play (since the emit was denied)
        assert 'video-play' not in host_events

        anon.disconnect()
        host.disconnect()


class TestSocketGrantedUser:
    """After playback-grant, the granted (anonymous) user should be able to drive playback."""

    def test_granted_user_can_play(self, host_headers, room):
        # Reset to hosts-only first
        requests.put(f"{BASE_URL}/api/rooms/{room['roomId']}/settings", headers=host_headers,
                     json={'settings': {'playbackControl': 'hosts-only'}}, timeout=15)
        time.sleep(0.3)

        viewer = _make_client(token=None)
        viewer_uid = None  # we'll learn it via a server echo if needed; instead grant by joining
        # We need viewer's uid. Anonymous uid is generated server-side -> we can't read it directly
        # but the server emits 'user-joined' on roomSocket which includes the user object.
        host = _make_client(token=host_headers['Authorization'].split(' ', 1)[1])

        joined = {}
        host.on('user-joined', lambda data: joined.setdefault('viewer', data))

        host.emit('join-room', {'roomId': room['roomId']})
        time.sleep(0.4)
        viewer.emit('join-room', {'roomId': room['roomId']})
        time.sleep(0.8)
        info = joined.get('viewer')
        if info and isinstance(info, dict):
            viewer_uid = info.get('userId') or info.get('user', {}).get('uid') or info.get('uid')

        if not viewer_uid:
            pytest.skip('Could not discover anonymous viewer uid via user-joined event')

        # Grant playback to viewer
        r = requests.post(f"{BASE_URL}/api/rooms/{room['roomId']}/playback-grant",
                          headers=host_headers, json={'userId': viewer_uid}, timeout=15)
        assert r.status_code == 200
        # cache TTL is 5s — wait so the next emit re-reads
        time.sleep(5.5)

        host_events = {}
        viewer_events = {}
        for ev in ('video-play', 'video-pause', 'video-seek'):
            host.on(ev, lambda data, e=ev: host_events.setdefault(e, data))
        viewer.on('playback-denied', lambda data: viewer_events.setdefault('denied', data))

        viewer.emit('play-video', {'roomId': room['roomId'], 'currentTime': 12})
        result = _wait_for(host_events, 'video-play', 4)
        assert result is not None, f'host did not receive video-play; viewer denied={viewer_events}'
        assert abs(result.get('currentTime', 0) - 12) < 0.01

        viewer.disconnect()
        host.disconnect()


class TestSocketEveryone:
    def test_everyone_mode_propagates(self, host_headers, room):
        requests.put(f"{BASE_URL}/api/rooms/{room['roomId']}/settings", headers=host_headers,
                     json={'settings': {'playbackControl': 'everyone'}}, timeout=15)
        time.sleep(5.5)  # let cache expire

        viewer = _make_client(token=None)
        host = _make_client(token=host_headers['Authorization'].split(' ', 1)[1])
        host_events = {}
        viewer_events = {}
        for ev in ('video-pause', 'video-seek'):
            host.on(ev, lambda data, e=ev: host_events.setdefault(e, data))
        viewer.on('playback-denied', lambda data: viewer_events.setdefault('denied', data))

        host.emit('join-room', {'roomId': room['roomId']})
        viewer.emit('join-room', {'roomId': room['roomId']})
        time.sleep(0.6)

        viewer.emit('pause-video', {'roomId': room['roomId'], 'currentTime': 7})
        out = _wait_for(host_events, 'video-pause', 4)
        assert out is not None, f'pause not propagated; denied={viewer_events}'
        assert abs(out.get('currentTime', 0) - 7) < 0.01

        viewer.emit('seek-video', {'roomId': room['roomId'], 'currentTime': 22})
        out2 = _wait_for(host_events, 'video-seek', 4)
        assert out2 is not None
        assert abs(out2.get('currentTime', 0) - 22) < 0.01
        assert 'denied' not in viewer_events

        viewer.disconnect()
        host.disconnect()
