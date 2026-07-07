"use client";

import Image from "next/image";
import { useState } from "react";
import { QrCodeIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function OrderImagePreview({
  src,
  alt,
  title,
  description,
  placeholderLabel = "Waiting for QR",
  className,
  imageClassName,
  width = 64,
  height = 64,
}: {
  src?: string | null;
  alt: string;
  title: string;
  description?: string;
  placeholderLabel?: string;
  className?: string;
  imageClassName?: string;
  width?: number;
  height?: number;
}) {
  const [open, setOpen] = useState(false);
  const hasImage = Boolean(src);

  if (!hasImage) {
    return (
      <div
        className={cn(
          "grid place-items-center rounded-2xl bg-muted/40 text-center text-muted-foreground ring-1 ring-foreground/10",
          imageClassName,
          className
        )}
        aria-label={placeholderLabel}
      >
        <div className="flex flex-col items-center gap-1 p-2">
          <QrCodeIcon className="size-5" />
          <span className="max-w-28 truncate text-[10px] leading-none">{placeholderLabel}</span>
        </div>
      </div>
    );
  }
  const imageSrc = String(src);

  return (
    <>
      <button
        type="button"
        className={cn("group/image-preview rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)}
        onClick={() => setOpen(true)}
        aria-label={title}
      >
        <Image
          src={imageSrc}
          alt={alt}
          width={width}
          height={height}
          unoptimized
          className={cn(
            "bg-muted object-contain ring-1 ring-foreground/10 transition group-hover/image-preview:opacity-85",
            imageClassName
          )}
        />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(92vw,760px)] rounded-3xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="grid place-items-center rounded-3xl bg-muted/40 p-3">
            <Image
              src={imageSrc}
              alt={alt}
              width={960}
              height={960}
              unoptimized
              className="max-h-[72vh] w-auto rounded-2xl object-contain ring-1 ring-foreground/10"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
