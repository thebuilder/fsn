import "./style.css";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("FSN desktop root element is missing");
}

app.innerHTML = `
  <section>
    <p>FSN DESKTOP</p>
    <h1>Desktop shell ready</h1>
    <p>The shared application will be mounted here.</p>
  </section>
`;
