import { PageMessage } from "@/components/ui/PageMessage";

export default function NotFound() {
    return (
        <PageMessage
            title="Page not found"
            description="This address doesn't lead anywhere in Kima."
            action={{ label: "Home", href: "/" }}
        />
    );
}
