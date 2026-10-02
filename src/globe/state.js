// Shared mutable state and late-bound hooks, so feature modules don't import the UI (which imports them).
export const state = {
  selected: null,        // the object whose card is open
  lookingAtMoon: false,  // the Moon preset parks the camera with lookAt; any other move must release it
};
export const hooks = {
  reselect: () => {},         // re-render the card for an object (after follow starts/stops)
  updateStats: () => {},
  applyVisibility: () => {},
  clearPresets: () => {},
};
