declare module "*.css";
declare module "*.css?raw" {
  const text: string;
  export default text;
}
