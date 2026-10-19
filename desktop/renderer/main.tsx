import { createRoot } from "react-dom/client";
import LibraryApp from "../../app/page";
import "../../app/globals.css";
import "../../app/library/desktop.css";

document.documentElement.dataset.desktop = "true";
createRoot(document.getElementById("root")!).render(<LibraryApp />);
