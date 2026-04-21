"use client";

import { useState } from "react";

export default function TestUpload() {
  const [file, setFile] = useState<File | null>(null);

  const handleUpload = async () => {
    if (!file) return alert("בחר קובץ");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("businessId", "1");
    formData.append("source", "gallery");

    const res = await fetch("/api/documents/upload", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    console.log(data);

    alert(JSON.stringify(data));
  };

  return (
    <div style={{ padding: 40 }}>
      <h1>Test Upload</h1>

      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
      />

      <br /><br />

      <button onClick={handleUpload}>
        Upload
      </button>
    </div>
  );
}