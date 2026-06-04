import Foundation
import Vision
import AppKit

struct OCRInput: Decodable {
    let imagePath: String
}

struct OCRElement: Encodable {
    let text: String
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let confidence: Double
}

struct OCROutput: Encodable {
    let elements: [OCRElement]
    let fullText: String
    let error: String?
}

// Read all of stdin as JSON
let stdinData = FileHandle.standardInput.readDataToEndOfFile()
guard let input = try? JSONDecoder().decode(OCRInput.self, from: stdinData) else {
    let err = OCROutput(elements: [], fullText: "", error: "Failed to decode input JSON")
    let d = try! JSONEncoder().encode(err)
    FileHandle.standardOutput.write(d)
    exit(1)
}

let url = URL(fileURLWithPath: input.imagePath)
guard let image = NSImage(contentsOf: url), image.isValid else {
    let err = OCROutput(elements: [], fullText: "", error: "Failed to load image: \(input.imagePath)")
    let d = try! JSONEncoder().encode(err)
    FileHandle.standardOutput.write(d)
    exit(1)
}

var proposedRect = NSRect.zero
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
    let err = OCROutput(elements: [], fullText: "", error: "Failed to get CGImage")
    let d = try! JSONEncoder().encode(err)
    FileHandle.standardOutput.write(d)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
} catch {
    let err = OCROutput(elements: [], fullText: "", error: "OCR failed: \(error.localizedDescription)")
    let d = try! JSONEncoder().encode(err)
    FileHandle.standardOutput.write(d)
    exit(1)
}

guard let observations = request.results else {
    let err = OCROutput(elements: [], fullText: "", error: "No OCR results")
    let d = try! JSONEncoder().encode(err)
    FileHandle.standardOutput.write(d)
    exit(1)
}

let imgWidth = CGFloat(cgImage.width)
let imgHeight = CGFloat(cgImage.height)
var elements: [OCRElement] = []
var fullTextParts: [String] = []

for obs in observations {
    guard let candidate = obs.topCandidates(1).first else { continue }
    let bbox = obs.boundingBox
    let bx = Int(bbox.origin.x * imgWidth)
    let by = Int((1 - bbox.origin.y - bbox.height) * imgHeight)
    let bw = Int(bbox.width * imgWidth)
    let bh = Int(bbox.height * imgHeight)
    elements.append(OCRElement(text: candidate.string, x: bx, y: by, width: bw, height: bh, confidence: Double(candidate.confidence)))
    fullTextParts.append(candidate.string)
}

let output = OCROutput(elements: elements, fullText: fullTextParts.joined(separator: "\n"), error: nil)
let encoded = try! JSONEncoder().encode(output)
FileHandle.standardOutput.write(encoded)
