import { Glob, type BunFile } from "bun";
import * as ExifReader from "exifreader";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import SunCalc from "suncalc";

const baseDir = "../../../../../../Volumes/Luke SSD";
const outputFileTemplate = "./timelapse/{{from}}-{{to}}.txt";

const readExifData = async (file: BunFile) => {
  try {
    const buffer = await file.arrayBuffer();
    const data = await ExifReader.load(buffer);
    return data;
  } catch (error) {
    console.error(`Error reading EXIF data from ${file.name}: ${error}`);
    return null;
  }
};

const parseExifDate = (date: string) => {
  const [year, month, day, hour, minute, second] = date.split(/:| /);
  return new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hour),
    parseInt(minute),
    parseInt(second)
  );
};

const isNightDate = (date: Date) => {
  const sunTimes = SunCalc.getTimes(date, 0, 0); // your lat and long here
  const offset = 1000 * 60 * 60 * 1; // 1 hour
  return (
    date.getTime() < sunTimes.sunrise.getTime() + offset ||
    date.getTime() > sunTimes.sunset.getTime() - offset
  );
};

const generateExifList = async (baseDir: string, outputFile: string) => {
  const glob = new Glob(baseDir + "/**/*.JPG");
  const files: { name?: string; date: Date }[] = [];
  const scannStart = Date.now();
  const scannedFiles = await Array.fromAsync(glob.scan("."));
  console.log(
    `Scanned ${scannedFiles.length} files in ${Date.now() - scannStart}ms`
  );

  const readFileStart = Date.now();
  await Promise.all(
    scannedFiles.map((filePath) => {
      const file = Bun.file(filePath);
      return readExifData(file).then((exifData) => {
        if (exifData) {
          if (Array.isArray(exifData.DateTime?.value)) {
            const [dateString] = exifData.DateTime?.value;
            const date = parseExifDate(dateString as string);
            if (!isNightDate(date)) {
              files.push({ name: file.name, date });
            }
          }
        } else {
          console.log("No exif for " + file.name);
        }
      });
    })
  );
  console.log(
    `Read ${scannedFiles.length} files in ${Date.now() - readFileStart}ms`
  );
  if (files.length > 0) {
    files.sort((a, b) => a.date.getTime() - b.date.getTime());
    const output = files.map((file) => `file '${file.name}'`);
    const fileName = outputFile
      .replace(
        "{{from}}",
        files[0].date.getFullYear() +
          "-" +
          files[0].date.getMonth() +
          "-" +
          files[0].date.getDate()
      )
      .replace(
        "{{to}}",
        files[files.length - 1].date.getFullYear() +
          "-" +
          files[files.length - 1].date.getMonth() +
          "-" +
          files[files.length - 1].date.getDate()
      );
    console.log(`Writing ${fileName}`);
    await Bun.write(fileName, output.join("\n"));
    console.log(`Wrote ${fileName}`);
    return fileName;
  }
};

const time = Date.now();
const fileNames = await readdir(baseDir);
const folderPaths = fileNames.map((fileName) => join(baseDir, fileName));
console.log(`Found ${folderPaths.length} folders`);
const outputFiles: string[] = [];
await Promise.all(
  folderPaths.map((folderPath) =>
    generateExifList(folderPath, `${outputFileTemplate}`).then((fileResult) => {
      if (fileResult) {
        outputFiles.push(fileResult);
      }
      console.log(`Finished ${folderPath}`);
    })
  )
);

await Promise.all(
  outputFiles.map((outputFile) => {
    try {
      const proc = Bun.spawn([
        `ffmpeg`,
        "-y",
        `-f`,
        `concat`,
        `-safe`,
        `0`,
        `-i`,
        `${outputFile}`,
        `-c:v`,
        `h264_videotoolbox`,
        `-framerate`,
        `30`,
        `-s:v`,
        `1920:1080`,
        `-crf`,
        `0`,
        `${outputFile.replace("txt", "mp4")}`,
      ]);
      return proc.exited;
    } catch (error) {
      console.error(`Error converting ${outputFile} to mp4: ${error}`);
    }
    console.log(`Finished ffmpeg ${outputFile}`);
  })
);

const sortDateRanges = (dateRanges: string[]): string[] => {
  return dateRanges.sort((a, b) => {
    // Split each range by "-" and compare the start dates
    const startDateA = a.split("-").slice(0, 3).join("-") as string;
    const startDateB = b.split("-").slice(0, 3).join("-") as string;
    return new Date(startDateA).getTime() - new Date(startDateB).getTime();
  });
};
const sortedOutputFiles = sortDateRanges(outputFiles);
await Bun.write(
  "./chunks.txt",
  sortedOutputFiles
    .map((file) => `file '${file.replace("txt", "mp4")}'`)
    .join("\n")
);

console.log("combining chunks...");
const proc = Bun.spawn([
  "ffmpeg",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  "./chunks.txt",
  "-c",
  "copy",
  "./timelapse/output.mp4",
]);

await proc.exited;
console.log(`Finished in ${Date.now() - time / 1000 / 60} minutes`);
console.log("Done! You can find the output at ./timelapse/output.mp4");
