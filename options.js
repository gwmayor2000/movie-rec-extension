// Storage key used to read/write the TMDB API key in chrome.storage.local
const STORAGE_KEY = "tmdbApiKey";

// Wait until the options page DOM is parsed, then load saved key and wire Save
document.addEventListener("DOMContentLoaded", async () => {
  // Reference to the password-style input where the user pastes the API key
  const keyInput = document.getElementById("apiKey");
  // Inline message area next to Save (e.g. "Saved.")
  const status = document.getElementById("status");
  // Read the whole storage object slice for our key
  const data = await chrome.storage.local.get(STORAGE_KEY);
  // If a key was saved before, pre-fill the input so the user can edit it
  if (data[STORAGE_KEY]) keyInput.value = data[STORAGE_KEY];

  // When the user clicks Save, persist the trimmed key (or empty string to clear)
  document.getElementById("save").addEventListener("click", async () => {
    // Trim whitespace from the pasted API key
    const v = keyInput.value.trim();
    // Write the key under STORAGE_KEY in local extension storage
    await chrome.storage.local.set({ [STORAGE_KEY]: v });
    // Confirm save or that the field was cleared
    status.textContent = v ? "Saved." : "Cleared.";
    // Hide the status text after two seconds so the UI stays clean
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
});
