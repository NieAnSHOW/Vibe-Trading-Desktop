import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { SceneFrame } from "./components/SceneFrame";
import { SCENES } from "./scenes";

export const ProductIntro = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#07111f",
        color: "#f5f8ff",
        fontFamily: "Arial, PingFang SC, Microsoft YaHei, sans-serif",
      }}
    >
      <Audio src={staticFile("audio/ambient-bed.mp3")} volume={0.8} />
      {SCENES.map((scene) => (
        <Sequence key={scene.id} from={scene.from} durationInFrames={scene.durationInFrames}>
          <SceneFrame frame={frame - scene.from} scene={scene} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
