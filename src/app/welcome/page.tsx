import type { Metadata } from "next";
import LandingPage from "@/features/landing/LandingPage";

export const metadata: Metadata = {
  title: "Recourse",
  description: "Recourse is an AI agent that phones a merchant or insurer to get your money back.",
};

export default function WelcomePage() {
  return <LandingPage />;
}
