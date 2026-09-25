module.exports = {
  // Keep the published storage baseline stable after restoring upstream image writers.
  extraSources: [
    {
      type: "contents",
      id: "composer-storage-baseline",
      contents: "file-backed-images-v1",
      reasons: ["Require an embedded file-backed image reader and storage guards"],
    },
  ],
};
