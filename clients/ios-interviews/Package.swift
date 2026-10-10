// swift-tools-version:5.9
// NOT COMPILED: written on Windows without a Swift toolchain. See README.md.
import PackageDescription

let package = Package(
    name: "InterviewsCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "InterviewsCore", targets: ["InterviewsCore"]),
    ],
    targets: [
        .target(name: "InterviewsCore"),
        .testTarget(name: "InterviewsCoreTests", dependencies: ["InterviewsCore"]),
    ]
)
