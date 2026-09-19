module.exports = {
  // File-backed writers must not OTA into binaries with the old draft readers.
  extraSources: [
    {
      type: "contents",
      id: "composer-storage-baseline",
      contents: "file-backed-images-v1",
      reasons: ["Require an embedded file-backed image reader and storage guards"],
    },
  ],
};
