"use client";

import { useId, useMemo } from "react";

export type AssetInputType = "image" | "video" | "voice";

export type AssetPlanItem = {
  id: string;
  title: string;
  description: string;
  type: AssetInputType;
  required: boolean;
};

export type UploadedAssetItem = {
  assetId: string;
  fileUrl: string;
  fileType: AssetInputType;
  fileName: string;
};

type AssetUploadItemProps = {
  asset: AssetPlanItem;
  uploaded?: UploadedAssetItem;
  onUpload: (file: File) => void;
};

function getAcceptByType(type: AssetInputType) {
  switch (type) {
    case "image":
      return "image/*";
    case "video":
      return "video/*";
    case "voice":
      return "audio/*";
    default:
      return "";
  }
}

function getTypeLabel(type: AssetInputType) {
  switch (type) {
    case "image":
      return "תמונה";
    case "video":
      return "וידאו";
    case "voice":
      return "אודיו";
    default:
      return "קובץ";
  }
}

export default function AssetUploadItem({
  asset,
  uploaded,
  onUpload,
}: AssetUploadItemProps) {
  const inputId = useId();

  const preview = useMemo(() => {
    if (!uploaded) {
      return null;
    }

    if (uploaded.fileType === "image") {
      return (
        <img
          src={uploaded.fileUrl}
          alt={asset.title}
          className="h-44 w-full rounded-2xl object-cover"
        />
      );
    }

    if (uploaded.fileType === "video") {
      return (
        <video
          src={uploaded.fileUrl}
          controls
          className="h-56 w-full rounded-2xl bg-black object-cover"
        />
      );
    }

    return (
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
        <audio src={uploaded.fileUrl} controls className="w-full" />
      </div>
    );
  }, [asset.title, uploaded]);

  return (
    <div className="rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            asset.required
              ? "bg-neutral-900 text-white"
              : "bg-neutral-100 text-neutral-700"
          }`}
        >
          {asset.required ? "חובה" : "אופציונלי"}
        </span>

        <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700">
          {getTypeLabel(asset.type)}
        </span>
      </div>

      <h3 className="text-base font-semibold text-neutral-900">{asset.title}</h3>

      <p className="mt-1 text-sm leading-6 text-neutral-600">
        {asset.description}
      </p>

      <div className="mt-4">
        {uploaded ? (
          <div className="space-y-3">
            {preview}

            <div className="rounded-2xl bg-neutral-50 p-3">
              <div className="text-xs text-neutral-500">הקובץ שנבחר</div>
              <div className="mt-1 break-all text-sm font-medium text-neutral-900">
                {uploaded.fileName}
              </div>
            </div>

            <label
              htmlFor={inputId}
              className="flex min-h-[48px] w-full cursor-pointer items-center justify-center rounded-2xl border border-neutral-300 px-4 py-3 text-sm font-medium text-neutral-900 transition active:scale-[0.99]"
            >
              החלף קובץ
            </label>
          </div>
        ) : (
          <label
            htmlFor={inputId}
            className="flex min-h-[56px] w-full cursor-pointer items-center justify-center rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-4 text-sm font-medium text-neutral-700 transition active:scale-[0.99]"
          >
            העלה {getTypeLabel(asset.type)}
          </label>
        )}

        <input
          id={inputId}
          type="file"
          accept={getAcceptByType(asset.type)}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) {
              return;
            }

            onUpload(file);

            event.currentTarget.value = "";
          }}
        />
      </div>
    </div>
  );
}