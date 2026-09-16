function popupShouldDisplay(popup, state) {
 if (!popup || !popup.enabled || typeof popup.title !== 'string') return false
 if (popup.frequency === 'daily') return state.storedDay !== state.day
 if (popup.frequency === 'session') return !state.sessionSeen
 if (popup.frequency === 'always') return !state.foregroundSeen
 return false
}
module.exports = { popupShouldDisplay }
