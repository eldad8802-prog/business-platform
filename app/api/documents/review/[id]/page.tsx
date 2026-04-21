"use client";

import { useEffect, useState } from "react";

export default function ReviewPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/documents/${params.id}`)
      .then((res) => res.json())
      .then(setData);
  }, [params.id]);

  if (!data) return <div>Loading...</div>;

  const { extracted } = data;

  const handleApprove = async () => {
    const res = await fetch(`/api/documents/${params.id}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(extracted),
    });

    const result = await res.json();
    alert("Approved!");
    console.log(result);
  };

  return (
    <div style={{ padding: 40 }}>
      <h1>Review Document</h1>

      <div>
        <label>Amount:</label>
        <input defaultValue={extracted.amount} />
      </div>

      <div>
        <label>Vendor:</label>
        <input defaultValue={extracted.vendorName} />
      </div>

      <div>
        <label>Category:</label>
        <input defaultValue="fuel" />
      </div>

      <br />

      <button onClick={handleApprove}>
        Approve
      </button>
    </div>
  );
}