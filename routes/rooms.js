const express = require('express');
const router = express.Router();
const roomService = require('../services/roomService');
const { verifyAuth } = require('../middleware/auth');
const { validateRoomName } = require('../utils/validation');
const handleVideoSocket = require('../sockets/videoSocket');

router.post('/create', verifyAuth, async (req, res) => {
  try {
    const { roomName } = req.body;
    
    // Validate room name
    const validation = validateRoomName(roomName);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }
    
    const result = await roomService.createRoom(req.user.uid, req.user.name, validation.sanitized);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/', verifyAuth, async (req, res) => {
  try {
    const result = await roomService.getActiveRooms();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/my/rooms', verifyAuth, async (req, res) => {
  try {
    const result = await roomService.getUserRooms(req.user.uid);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:roomId', verifyAuth, async (req, res) => {
  try {
    const result = await roomService.getRoom(req.params.roomId);
    res.status(result.success ? 200 : 404).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:roomId/join', verifyAuth, async (req, res) => {
  try {
    const result = await roomService.joinRoom(req.params.roomId, req.user.uid, req.user.name);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:roomId/leave', verifyAuth, async (req, res) => {
  try {
    const result = await roomService.leaveRoom(req.params.roomId, req.user.uid);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:roomId/role', verifyAuth, async (req, res) => {
  try {
    const { userId, role } = req.body;
    const result = await roomService.updateUserRole(req.params.roomId, userId, role, req.user.uid);
    res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:roomId/kick', verifyAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    const result = await roomService.kickUser(req.params.roomId, userId, req.user.uid);
    if (result.success && req.app.get('io')) {
      const io = req.app.get('io');
      io.to(req.params.roomId).emit('user-kicked', { userId, by: req.user.uid });
    }
    res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:roomId/ban', verifyAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    const result = await roomService.banUser(req.params.roomId, userId, req.user.uid);
    if (result.success && req.app.get('io')) {
      const io = req.app.get('io');
      io.to(req.params.roomId).emit('user-banned', { userId, by: req.user.uid });
    }
    res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:roomId/settings', verifyAuth, async (req, res) => {
  try {
    const { settings } = req.body;
    const result = await roomService.updateSettings(req.params.roomId, settings || {}, req.user.uid);
    if (result.success) {
      handleVideoSocket.invalidateRoomCache(req.params.roomId);
      if (req.app.get('io')) {
        const io = req.app.get('io');
        io.to(req.params.roomId).emit('settings-updated', { settings: result.settings });
      }
    }
    const status = result.success ? 200 : (result.code || 403);
    res.status(status).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:roomId/playback-grant', verifyAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    const result = await roomService.grantPlayback(req.params.roomId, userId, req.user.uid);
    if (result.success) {
      handleVideoSocket.invalidateRoomCache(req.params.roomId);
      if (req.app.get('io')) {
        const io = req.app.get('io');
        io.to(req.params.roomId).emit('settings-updated', { settings: result.settings });
        io.to(req.params.roomId).emit('playback-permission-changed', { userId, granted: true });
      }
    }
    res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:roomId/playback-revoke', verifyAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    const result = await roomService.revokePlayback(req.params.roomId, userId, req.user.uid);
    if (result.success) {
      handleVideoSocket.invalidateRoomCache(req.params.roomId);
      if (req.app.get('io')) {
        const io = req.app.get('io');
        io.to(req.params.roomId).emit('settings-updated', { settings: result.settings });
        io.to(req.params.roomId).emit('playback-permission-changed', { userId, granted: false });
      }
    }
    res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:roomId', verifyAuth, async (req, res) => {
  try {
    const result = await roomService.deleteRoom(req.params.roomId, req.user.uid);
    res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
