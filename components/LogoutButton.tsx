"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Button } from "./ui";

export default function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  return (
    <Button
      variant="ghost"
      loading={loading}
      onClick={async () => {
        setLoading(true);
        try {
          await api.post("/api/auth/logout");
          router.push("/");
          router.refresh();
        } finally {
          setLoading(false);
        }
      }}
    >
      Sign out
    </Button>
  );
}
