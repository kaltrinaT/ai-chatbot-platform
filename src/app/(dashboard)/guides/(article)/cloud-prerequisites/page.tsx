import { Cloud } from "lucide-react";
import GuideHeader from "../GuideHeader";
import CloudPrerequisitesContent from "./CloudPrerequisitesContent";

export default function CloudPrerequisitesPage() {
  return (
    <div className="max-w-6xl px-8 py-8">
      <GuideHeader
        current="Cloud Prerequisites"
        icon={Cloud}
        tone="blue"
        title="Cloud Prerequisites"
        subtitle="Prepare your AWS or Azure environment with the required permissions and access."
      />

      <div className="mt-8 border-t pt-8">
        <CloudPrerequisitesContent />
      </div>
    </div>
  );
}
